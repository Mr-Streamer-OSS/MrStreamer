package app.mrstreamer.player

import androidx.media3.common.util.UnstableApi
import androidx.media3.test.utils.TestExoPlayerBuilder
import androidx.media3.test.utils.robolectric.RobolectricUtil
import java.io.File
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/** Real native owner: relay readers fence release and deletion after local output detaches. */
@UnstableApi
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class CastOwnerTest {
  @Test fun retainedAdmissionOwnsRemoteReaders() {
    val context = RuntimeEnvironment.getApplication()
    val player = TestExoPlayerBuilder(context).build()
    val releases = mutableListOf<Release>()
    val owner = PlayerOwner(player, object : PlayerEvents {
      override fun observed(observation: Observation) {}
      override fun tracks(attempt: String, tracks: List<Track>) {}
      override fun released(release: Release) { releases.add(release) }
    })
    val file = File.createTempFile("cast-owner", ".mp4", context.cacheDir)
    javaClass.classLoader!!.getResourceAsStream("media/h264-aac.mp4")!!.use { input -> file.outputStream().use { input.copyTo(it) } }
    var close: (() -> Unit)? = null
    try {
      val admission = Admission("cast", file.toURI().toString(), emptyMap(), "progressive", "file", 0, HoldRef.LocalFile(file.path))
      owner.admit(admission)
      assertNull(owner.reserveOutput("stale"))
      assertEquals(admission, owner.reserveOutput("cast"))
      close = owner.outputReader("cast")
      assertNotNull(close)
      assertThrows(IllegalStateException::class.java) { LocalFiles.unused(file.path) { file.delete() } }
      assertTrue(owner.remoteOutput("cast"))
      assertEquals("cast", owner.attempt)
      owner.stop("cast")
      assertTrue(releases.isEmpty())
      close!!.invoke()
      RobolectricUtil.runMainLooperUntil { releases.isNotEmpty() }
      assertEquals("file-closed", releases.single().outcome)
      LocalFiles.unused(file.path) { assertTrue(file.delete()) }
    } finally {
      close?.invoke()
      owner.stopAll()
      player.release()
      file.delete()
    }
  }
}
