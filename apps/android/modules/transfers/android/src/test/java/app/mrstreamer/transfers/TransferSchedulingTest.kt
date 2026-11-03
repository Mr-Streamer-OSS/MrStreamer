package app.mrstreamer.transfers

import android.content.Context
import androidx.work.*
import androidx.work.testing.WorkManagerTestInitHelper
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.Assert.*
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** A public Worker that lets the test observe retry backoff and active unique work. */
class SchedulingProbe(context: Context, params: WorkerParameters) : Worker(context, params) {
  override fun doWork(): Result {
    entered.countDown()
    check(release.await(5, TimeUnit.SECONDS))
    return Result.retry()
  }
  companion object {
    var entered = CountDownLatch(1)
    var release = CountDownLatch(1)
  }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class TransferSchedulingTest {
  private val context: Context get() = RuntimeEnvironment.getApplication()
  private val executor = Executors.newSingleThreadExecutor()
  private val manager get() = WorkManager.getInstance(context)

  @Before fun prepare() {
    Transfers.clearAuthority()
    Ledger(context).save(emptyList())
    SchedulingProbe.entered = CountDownLatch(1)
    SchedulingProbe.release = CountDownLatch(1)
    WorkManagerTestInitHelper.initializeTestWorkManager(context,
      Configuration.Builder().setExecutor(executor).build())
  }
  @After fun cleanup() {
    SchedulingProbe.release.countDown()
    manager.cancelAllWork().result.get()
    executor.shutdownNow()
    executor.awaitTermination(5, TimeUnit.SECONDS)
    SchedulingProbe.entered = CountDownLatch(0)
    SchedulingProbe.release = CountDownLatch(0)
    Transfers.clearAuthority()
    Ledger(context).save(emptyList())
    Ledger(context).root.deleteRecursively()
  }
  private fun observed(condition: () -> Boolean) {
    val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
    while (!condition()) {
      check(System.nanoTime() < deadline) { "Expected WorkManager transition did not occur" }
      Thread.yield()
    }
  }
  private fun probe(): OneTimeWorkRequest {
    val request = OneTimeWorkRequestBuilder<SchedulingProbe>()
      .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build()
    manager.enqueueUniqueWork("downloads", ExistingWorkPolicy.REPLACE, request).result.get()
    assertTrue(SchedulingProbe.entered.await(5, TimeUnit.SECONDS))
    return request
  }

  @Test fun explicitKickReplacesBackoffWithAFreshEligibleRequest() {
    val previous = probe()
    SchedulingProbe.release.countDown()
    observed { manager.getWorkInfoById(previous.id).get()?.let { it.state == WorkInfo.State.ENQUEUED && it.runAttemptCount == 1 } == true }
    assertTrue(manager.getWorkInfoById(previous.id).get()!!.nextScheduleTimeMillis > System.currentTimeMillis())
    Transfers.kick(context)
    // REPLACE deletes the old record, so CANCELLED need not remain observable.
    observed { manager.getWorkInfoById(previous.id).get().let { it == null || it.state == WorkInfo.State.CANCELLED } }
    observed { manager.getWorkInfosForUniqueWork("downloads").get().any { it.id != previous.id && it.state == WorkInfo.State.ENQUEUED } }
    val successor = manager.getWorkInfosForUniqueWork("downloads").get().single { it.id != previous.id }
    assertEquals(0, successor.runAttemptCount)
    assertEquals(0L, successor.initialDelayMillis)
    assertEquals(WorkInfo.State.ENQUEUED, successor.state)
    // TestDriver rewinds scheduling time. Check eligibility before releasing its network gate.
    assertTrue(successor.nextScheduleTimeMillis <= System.currentTimeMillis())
    WorkManagerTestInitHelper.getTestDriver(context)!!.setAllConstraintsMet(successor.id)
    observed { manager.getWorkInfoById(successor.id).get()?.state == WorkInfo.State.SUCCEEDED }
  }

  @Test fun explicitKickPreservesRunningWorkAndAppendsItsSuccessor() {
    val running = probe()
    Transfers.kick(context)
    observed { manager.getWorkInfosForUniqueWork("downloads").get().size == 2 }
    assertEquals(WorkInfo.State.RUNNING, manager.getWorkInfoById(running.id).get()!!.state)
    val successor = manager.getWorkInfosForUniqueWork("downloads").get().single { it.id != running.id }
    assertEquals(WorkInfo.State.BLOCKED, successor.state)
  }
}
