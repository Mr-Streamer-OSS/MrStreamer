package app.mrstreamer.transfers

import android.content.Context
import androidx.work.Configuration
import androidx.work.WorkManager
import androidx.work.testing.WorkManagerTestInitHelper
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.ModulesProvider
import expo.modules.kotlin.functions.SuspendFunctionComponent
import org.json.JSONObject
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.Assert.*
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.util.ReflectionHelpers
import org.robolectric.util.ReflectionHelpers.ClassParameter
import java.lang.ref.WeakReference
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.runBlocking
import com.facebook.react.bridge.ReactApplicationContext

/** Substitute the hosting React context, without loading Hermes or creating a JS runtime. */
@Implements(value = AppContext::class, isInAndroidSdk = false)
class DownloadAppContextShadow {
  @Implementation fun __constructor__(provider: ModulesProvider?, registry: expo.modules.core.ModuleRegistry?, holder: WeakReference<ReactApplicationContext>?) { }
  @Implementation fun getReactContext(): Context = RuntimeEnvironment.getApplication()
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], shadows = [DownloadAppContextShadow::class],
  instrumentedPackages = ["expo.modules.kotlin", "app.mrstreamer.transfers"])
class TransferBridgeTest {
  private val context: Context get() = RuntimeEnvironment.getApplication()
  private val ledger get() = Ledger(context)
  private val executor = Executors.newSingleThreadExecutor()
  private lateinit var module: TransfersModule

  @Before fun prepare() {
    Transfers.clearAuthority()
    ledger.root.deleteRecursively()
    WorkManagerTestInitHelper.initializeTestWorkManager(context,
      Configuration.Builder().setExecutor(executor).build())
    val app = ReflectionHelpers.callConstructor(AppContext::class.java,
      ClassParameter.from(ModulesProvider::class.java, null),
      ClassParameter.from(expo.modules.core.ModuleRegistry::class.java, null),
      ClassParameter.from(WeakReference::class.java, WeakReference<ReactApplicationContext>(null)))
    module = TransfersModule()
    ReflectionHelpers.setField(module, "_appContextHolder", WeakReference(app))
  }

  @After fun cleanup() {
    SchedulingProbe.release.countDown()
    WorkManager.getInstance(context).cancelAllWork().result.get()
    executor.shutdownNow()
    executor.awaitTermination(5, TimeUnit.SECONDS)
    Transfers.clearAuthority()
    ledger.save(emptyList())
    ledger.root.deleteRecursively()
    SchedulingProbe.entered = java.util.concurrent.CountDownLatch(0)
    SchedulingProbe.release = java.util.concurrent.CountDownLatch(0)
  }

  /** Invoke the registered Expo export. Reflection adapts Expo's private dispatcher, not product logic. */
  @Suppress("UNCHECKED_CAST")
  private fun call(name: String, vararg args: Any?): Any? {
    val function = module.definition().asyncFunctions.getValue(name)
    return if (function is SuspendFunctionComponent) {
      val body = ReflectionHelpers.getField<suspend CoroutineScope.(Array<out Any?>) -> Any?>(function, "body")
      runBlocking { body(args) }
    } else {
      val body = ReflectionHelpers.getField<(Array<out Any?>) -> Any?>(function, "body")
      body(args)
    }
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
        assertEquals(ledger.media(id).absolutePath, call("path", id))
        assertEquals("complete", ledger.read().single().getString("state"))
      } else {
        assertThrows(Exception::class.java) { call("path", id) }
        val persisted = ledger.read().single()
        assertEquals("failed", persisted.getString("state"))
        assertEquals("missing", persisted.getString("reason"))
        assertEquals("missing", JSONObject(call("snapshot") as String).getJSONArray("rows").getJSONObject(0).getString("reason"))
      }
    }
  }

  @Test fun restoreReconcilesOrphanedWorkAndClearsProcessAndLegacyHolds() {
    val row = row("running").put("blocked", true).put("bytes", 0)
    val id = row.getString("id")
    ledger.media(id, true).writeText("part")
    Transfers.block(context, "source", true)
    // A legacy process hold must not survive a cold restore.
    java.io.File(ledger.root, "ledger.json").writeText(org.json.JSONArray(listOf(row)).toString())
    val result = JSONObject(call("restore") as String).getJSONArray("rows").getJSONObject(0)
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
    val restored = JSONObject(call("restore") as String).getJSONArray("rows").getJSONObject(0)
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
