package app.mrstreamer.player

import android.net.Uri
import android.os.Handler
import android.os.Looper
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.FileDataSource
import java.io.File
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowLooper

@UnstableApi
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class HoldTest {
  @Test fun fileFactoryFencesRemovalAndRetiredAttemptsUntilClose() {
    val file = File(RuntimeEnvironment.getApplication().cacheDir, "hold-test").apply { writeText("media") }
    var settled: Boolean? = null
    val hold = Hold(Handler(Looper.getMainLooper())) { settled = it }
    val source = hold.factory(FileDataSource.Factory()) { true }.createDataSource()
    try {
      source.open(DataSpec(Uri.fromFile(file)))
      assertThrows(IllegalStateException::class.java) { LocalFiles.unused(file.absolutePath) { file.delete() } }
      hold.retire()
      ShadowLooper.idleMainLooper()
      assertNull(settled)
      source.close()
      ShadowLooper.idleMainLooper()
      assertEquals(true, settled)
      assertTrue(LocalFiles.unused(file.absolutePath) { file.delete() })
      assertThrows(java.io.IOException::class.java) { source.open(DataSpec(Uri.fromFile(file))) }
    } finally { source.close(); file.delete() }
  }

  @Test fun removalCannotRaceAnUpstreamOpen() {
    val file = File(RuntimeEnvironment.getApplication().cacheDir, "hold-race").apply { writeText("media") }
    val entered = java.util.concurrent.CountDownLatch(1)
    val resume = java.util.concurrent.CountDownLatch(1)
    val executor = java.util.concurrent.Executors.newFixedThreadPool(2)
    val upstream = FileDataSource()
    val factory = androidx.media3.datasource.DataSource.Factory {
      object : androidx.media3.datasource.DataSource by upstream {
        override fun open(spec: DataSpec): Long {
          entered.countDown()
          check(resume.await(5, java.util.concurrent.TimeUnit.SECONDS))
          return upstream.open(spec)
        }
      }
    }
    val hold = Hold(Handler(Looper.getMainLooper())) {}
    val source = hold.factory(factory) { true }.createDataSource()
    try {
      val opening = executor.submit<Long> { source.open(DataSpec(Uri.fromFile(file))) }
      assertTrue(entered.await(5, java.util.concurrent.TimeUnit.SECONDS))
      val removal = executor.submit<Boolean> {
        try { LocalFiles.unused(file.absolutePath) { file.delete() } }
        catch (_: IllegalStateException) { false }
      }
      resume.countDown()
      assertEquals(5L, opening.get(5, java.util.concurrent.TimeUnit.SECONDS))
      assertFalse(removal.get(5, java.util.concurrent.TimeUnit.SECONDS))
      assertTrue(file.exists())
    } finally {
      resume.countDown()
      executor.shutdownNow()
      executor.awaitTermination(5, java.util.concurrent.TimeUnit.SECONDS)
      source.close()
      file.delete()
    }
  }

  @Test fun failedFileOpenReleasesRegistryAndAttemptWithoutRequiringClose() {
    val file = File(RuntimeEnvironment.getApplication().cacheDir, "hold-absent")
    file.delete()
    var settled: Boolean? = null
    val hold = Hold(Handler(Looper.getMainLooper())) { settled = it }
    val source = hold.factory(FileDataSource.Factory()) { true }.createDataSource()
    try {
      assertThrows(java.io.IOException::class.java) { source.open(DataSpec(Uri.fromFile(file))) }
      hold.retire()
      ShadowLooper.idleMainLooper()
      assertEquals(true, settled)
      assertTrue(LocalFiles.unused(file.absolutePath) { true })
    } finally { source.close(); file.delete() }
  }
}
