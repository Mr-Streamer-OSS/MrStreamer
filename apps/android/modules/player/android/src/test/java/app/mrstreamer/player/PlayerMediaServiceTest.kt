package app.mrstreamer.player

import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import androidx.media3.common.Player
import androidx.media3.session.MediaSession
import androidx.media3.test.utils.FakeMediaSource
import androidx.media3.test.utils.FakeRenderer
import androidx.media3.test.utils.TestExoPlayerBuilder
import androidx.media3.test.utils.robolectric.RobolectricUtil
import org.junit.After
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowLooper

@UnstableApi
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PlayerMediaServiceTest {
  @After fun reset() = resetPlayerState()

  /** A retained player must not let a dead service issue another foreground start. */
  @Test fun playbackAfterServiceDestructionDoesNotRestartDeadService() {
    val context = RuntimeEnvironment.getApplication()
    val player = TestExoPlayerBuilder(context).setRenderers(FakeRenderer(C.TRACK_TYPE_AUDIO)).build()
    val session = MediaSession.Builder(context, player).build()
    val service = Robolectric.buildService(PlayerMediaService::class.java).create()
    try {
      service.get().addSession(session)
      player.setMediaSource(FakeMediaSource())
      player.prepare()
      RobolectricUtil.runMainLooperUntil {
        player.playbackState == Player.STATE_READY && session.connectedControllers.isNotEmpty()
      }
      val app = shadowOf(context)
      app.clearStartedServices() // Starts issued while the service was alive are expected.
      service.destroy()
      player.play()
      RobolectricUtil.runMainLooperUntil { player.isPlaying }
      // Flush the actual Media3 notification controller's asynchronous state updates.
      ShadowLooper.idleMainLooper()
      assertNull("Destroyed notification owner must not call startForegroundService", app.nextStartedService)
      val replacement = Robolectric.buildService(PlayerMediaService::class.java).create()
      try {
        replacement.get().addSession(session)
        RobolectricUtil.runMainLooperUntil { replacement.get().isPlaybackOngoing }
        assertNotNull("The replacement notification owner must be able to start foreground playback", app.nextStartedService)
      } finally { replacement.destroy() }
    } finally {
      session.release()
      player.release()
    }
  }

  /** External destruction recovers immediately, without waiting for another player event. */
  @Test fun externallyDestroyedServiceRecoversRetainedSession() {
    val context = RuntimeEnvironment.getApplication()
    val app = shadowOf(context)
    val owner = PlayerHost.owner(context)
    owner.admit(admission("first"))
    assertNotNull(app.nextStartedService)
    val session = PlayerHost.session!!
    val service = Robolectric.buildService(PlayerMediaService::class.java).create()
    RobolectricUtil.runMainLooperUntil { session.connectedControllers.isNotEmpty() }
    app.clearStartedServices()
    service.destroy()
    RobolectricUtil.runMainLooperUntil { session.connectedControllers.isEmpty() }
    assertSame("Destruction preserves the process session", session, PlayerHost.session)
    assertEquals("first", owner.attempt)
    val restart = app.nextStartedService
    assertNotNull("External destruction must request a new service without another owner event", restart)
    assertEquals(PlayerMediaService::class.java.name, restart!!.component!!.className)
    assertNull("Recovery uses the host start, not a dead Media3 notification intent", restart.extras)
    val replacement = Robolectric.buildService(PlayerMediaService::class.java).create()
    try {
      RobolectricUtil.runMainLooperUntil { session.connectedControllers.isNotEmpty() }
      assertSame(session, replacement.get().sessions.single())
      assertTrue(owner.admit(admission("replacement")))
      assertEquals("replacement", owner.attempt)
      assertSame(session, PlayerHost.session)
      owner.stopAll()
      app.clearStartedServices()
    } finally { replacement.destroy() }
    ShadowLooper.idleMainLooper()
    assertNull("Explicit Close must not restart the replacement", app.nextStartedService)
    assertTrue(owner.admit(admission("subsequent")))
    assertNotNull("Subsequent admission must request its own service", app.nextStartedService)
    val subsequent = Robolectric.buildService(PlayerMediaService::class.java).create()
    try {
      RobolectricUtil.runMainLooperUntil { session.connectedControllers.isNotEmpty() }
      assertSame(session, subsequent.get().sessions.single())
    } finally {
      owner.stopAll()
      subsequent.destroy()
    }
  }

  /** Switching to preview must not recreate the service when its old instance is destroyed. */
  @Test fun previewTeardownDoesNotRestartService() {
    val context = RuntimeEnvironment.getApplication()
    val owner = PlayerHost.owner(context)
    owner.admit(admission("watch"))
    val session = PlayerHost.session!!
    val service = Robolectric.buildService(PlayerMediaService::class.java).create()
    RobolectricUtil.runMainLooperUntil { session.connectedControllers.isNotEmpty() }
    val activity = Robolectric.buildActivity(android.app.Activity::class.java).setup().get()
    PlayerPip.attach(activity)
    PlayerPip.started()
    assertTrue(owner.admit(admission("preview").copy(preview = true)))
    val app = shadowOf(context)
    app.clearStartedServices()
    service.destroy()
    ShadowLooper.idleMainLooper()
    assertNull(PlayerHost.session)
    assertEquals("preview", owner.attempt)
    assertNull("Preview teardown must not restart a media service", app.nextStartedService)
    owner.stopAll()
    PlayerPip.detach(activity)
    activity.finish()
  }

  private fun admission(attempt: String) = Admission(attempt, "file:///missing", emptyMap(),
    "progressive", "live", 0, HoldRef.LocalFile("/missing"))
}
