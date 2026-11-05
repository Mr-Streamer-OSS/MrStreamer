package app.mrstreamer.transfers

import android.content.Context
import androidx.work.Configuration
import androidx.work.WorkManager
import androidx.work.testing.WorkManagerTestInitHelper
import org.json.JSONObject
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.Assert.*
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** Public transfer entry points backed by the durable ledger and real test WorkManager. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], shadows = [DownloadCredentialShadow::class, DownloadBindingShadow::class],
  instrumentedPackages = ["app.mrstreamer.credentials", "app.mrstreamer.transfers"])
class TransferBridgeTest {
  private val context: Context get() = RuntimeEnvironment.getApplication()
  private val ledger get() = Ledger(context)
  private val executor = Executors.newSingleThreadExecutor()

  @Before fun prepare() {
    Transfers.clearAuthority()
    DownloadCredentialShadow.authority = "fictional-test-authority"
    DownloadBindingShadow.binding = "test-binding"
    ledger.root.deleteRecursively()
    WorkManagerTestInitHelper.initializeTestWorkManager(context,
      Configuration.Builder().setExecutor(executor).build())
  }

  @After fun cleanup() {
    SchedulingProbe.release.countDown()
    WorkManager.getInstance(context).cancelAllWork().result.get()
    DownloadCredentialShadow.authority = null
    DownloadBindingShadow.binding = "test-binding"
    executor.shutdownNow()
    executor.awaitTermination(5, TimeUnit.SECONDS)
    Transfers.clearAuthority()
    ledger.save(emptyList())
    ledger.root.deleteRecursively()
    SchedulingProbe.entered = java.util.concurrent.CountDownLatch(0)
    SchedulingProbe.release = java.util.concurrent.CountDownLatch(0)
  }

  private fun row(state: String) = JSONObject().put("id", UUID.randomUUID().toString())
    .put("sourceId", "source").put("state", state).put("total", 8).put("bytes", 8)
    .put("attempt", "old").put("binding", "private").put("reason", "").put("title", "Copy")

  @Test fun pathRefusalPersistsMissingAndValidExactSizeCopyIsReturned() {
    for (size in listOf(-1, 0, 4, 8)) {
      val row = row("complete")
      val id = row.getString("id")
      ledger.save(listOf(row))
      if (size >= 0) ledger.media(id).writeBytes(ByteArray(size))
      if (size == 8) {
        assertEquals(ledger.media(id).absolutePath, Transfers.path(context, id))
        assertEquals("complete", ledger.read().single().getString("state"))
      } else {
        assertThrows(Exception::class.java) { Transfers.path(context, id) }
        val persisted = ledger.read().single()
        assertEquals("failed", persisted.getString("state"))
        assertEquals(if (size < 0) "missing" else "file-changed", persisted.getString("reason"))
        assertEquals(if (size < 0) "missing" else "file-changed", JSONObject(Transfers.snapshot(context, false)).getJSONArray("rows").getJSONObject(0).getString("reason"))
      }
    }
  }

  private fun request() = JSONObject().put("sourceId", "source").put("kind", "episode")
    .put("mediaId", "episode").put("container", "mp4").put("title", "Series")
    .put("key", org.json.JSONArray(listOf("source", "episode", "episode", "mp4")).toString())

  @Test fun bulkReviewAcceptsJsonIdentityWithUnescapedSlashes() {
    val request = request().put("sourceId", "folder/source")
      .put("key", "[\"folder/source\",\"episode\",\"episode\",\"mp4\"]")
    val token = JSONObject(Transfers.review(context, org.json.JSONArray(listOf(request)).toString())).getString("token")
    Transfers.endReview(token)
  }

  @Test fun bulkAdmissionChecksDurableDuplicatesAndCredentialRevocation() {
    val request = request()
    val key = request.getString("key")
    val token = JSONObject(Transfers.review(context, org.json.JSONArray(listOf(request)).toString())).getString("token")
    // Another caller queued the exact file after confirmation opened.
    val other = row("paused").put("key", key)
    ledger.save(listOf(other))
    assertEquals("skipped", Transfers.admit(context, token, key, "none"))
    assertEquals(other.getString("id"), ledger.read().single().getString("id"))
    DownloadBindingShadow.binding = "new-login"
    assertEquals("login", Transfers.admit(context, token, key, "none"))
    Transfers.endReview(token)
    assertEquals("stopped", Transfers.admit(context, token, key, "none"))
  }

  @Test fun bulkReplacementLeavesAReappearingMissingCopyAlone() {
    val request = request()
    val key = request.getString("key")
    val old = row("failed").put("key", key).put("reason", "missing")
    ledger.save(listOf(old))
    val token = JSONObject(Transfers.review(context, org.json.JSONArray(listOf(request)).toString())).getString("token")
    val id = old.getString("id")
    ledger.media(id).writeBytes(ByteArray(8))
    assertEquals("skipped", Transfers.admit(context, token, key, "missing"))
    assertTrue(ledger.media(id).exists())
    assertEquals(id, ledger.read().single().getString("id"))
    assertEquals("complete", ledger.read().single().getString("state"))
    Transfers.endReview(token)
  }

  @Test fun nativeReadersRefuseRemovalWithoutChangingTheSavedCopy() {
    val row = row("complete")
    val id = row.getString("id")
    ledger.save(listOf(row))
    ledger.media(id).writeBytes(ByteArray(8))
    val path = Transfers.path(context, id)
    app.mrstreamer.player.LocalFiles.opened(path)
    try {
      assertThrows(Exception::class.java) { Transfers.command(context, id, "remove") }
      assertEquals("complete", ledger.read().single().getString("state"))
      assertTrue(ledger.media(id).exists())
    } finally { app.mrstreamer.player.LocalFiles.closed(path) }
    Transfers.command(context, id, "remove")
    assertTrue(ledger.read().isEmpty())
    assertFalse(ledger.media(id).exists())
  }

  @Test fun restoreReconcilesOrphanedWorkAndClearsProcessAndLegacyHolds() {
    val row = row("running").put("blocked", true).put("bytes", 0)
    val id = row.getString("id")
    ledger.media(id, true).writeText("part")
    Transfers.block(context, "source", true)
    val manager = WorkManager.getInstance(context)
    manager.cancelAllWork().result.get()
    assertTrue(manager.getWorkInfosForUniqueWork("downloads").get().none { it.state == androidx.work.WorkInfo.State.RUNNING })
    // A legacy process hold must not survive a cold restore.
    java.io.File(ledger.root, "ledger.json").writeText(org.json.JSONArray(listOf(row)).toString())
    val result = JSONObject(Transfers.restore(context)).getJSONArray("rows").getJSONObject(0)
    assertFalse(result.getBoolean("blocked"))
    assertFalse(Transfers.isBlocked("source"))
    val current = ledger.read().single()
    assertEquals("queued", current.getString("state"))
    assertNotEquals("old", current.getString("attempt"))
    assertEquals("part", ledger.media(id, true).readText())
    assertFalse(current.has("blocked"))
  }

  @Test fun restorePreservesRunningAttemptAndSchedulesWithoutCancellingIt() {
    SchedulingProbe.entered = java.util.concurrent.CountDownLatch(1)
    SchedulingProbe.release = java.util.concurrent.CountDownLatch(1)
    val manager = WorkManager.getInstance(context)
    Transfers.block(context, "source", true)
    val request = androidx.work.OneTimeWorkRequestBuilder<SchedulingProbe>().build()
    manager.enqueueUniqueWork("downloads", androidx.work.ExistingWorkPolicy.REPLACE, request).result.get()
    assertTrue(SchedulingProbe.entered.await(5, TimeUnit.SECONDS))
    val row = row("running")
    val id = row.getString("id")
    ledger.media(id, true).writeText("12345678")
    ledger.save(listOf(row))
    val restored = JSONObject(Transfers.restore(context)).getJSONArray("rows").getJSONObject(0)
    assertFalse(restored.getBoolean("blocked"))
    assertFalse(Transfers.isBlocked("source"))
    assertEquals("running", ledger.read().single().getString("state"))
    assertEquals("old", ledger.read().single().getString("attempt"))
    assertTrue(ledger.media(id, true).exists())
    assertFalse(ledger.media(id).exists())
    assertEquals(androidx.work.WorkInfo.State.RUNNING, manager.getWorkInfoById(request.id).get()!!.state)
    val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
    while (manager.getWorkInfosForUniqueWork("downloads").get().none { it.state == androidx.work.WorkInfo.State.BLOCKED }) {
      check(System.nanoTime() < deadline)
      Thread.yield()
    }
  }
}
