package app.mrstreamer.player

import android.content.Context
import android.content.Intent
import androidx.media3.common.util.UnstableApi
import androidx.media3.common.C
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

@UnstableApi
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PlayerMediaServiceTest {
  @After fun reset() = resetPlayerState()

  /** A retained player must not let a dead service issue another foreground start. */
  @Test fun playbackAfterServiceDestructionDoesNotRestartDeadService() {
    val context: Context = RuntimeEnvironment.getApplication()
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
      service.destroy()
      val app = shadowOf(RuntimeEnvironment.getApplication())
      while (app.nextStartedService != null) { /* Drain starts from the live service. */ }
      player.play()
      RobolectricUtil.runMainLooperUntil { player.isPlaying }
      // Flush the actual Media3 notification controller's asynchronous state updates.
      org.robolectric.shadows.ShadowLooper.idleMainLooper()
      assertNull("Destroyed notification owner must not call startForegroundService", app.nextStartedService)
    } finally {
      session.release()
      player.release()
    }
  }

  /** Destroying a service must disconnect its notification controller, not the process session. */
  @Test fun destroyedServiceDisconnectsFromRetainedSession() {
    val context: Context = RuntimeEnvironment.getApplication()
    val owner = PlayerHost.owner(context)
    owner.admit(Admission("live", "file:///missing", emptyMap(), "progressive", "live", 0,
      HoldRef.LocalFile("/missing")))
    val session = PlayerHost.session!!
    val service = Robolectric.buildService(PlayerMediaService::class.java).create()
    try {
      service.get().onStartCommand(Intent(context, PlayerMediaService::class.java), 0, 1)
      RobolectricUtil.runMainLooperUntil { session.connectedControllers.isNotEmpty() }
      service.destroy()
      RobolectricUtil.runMainLooperUntil { session.connectedControllers.isEmpty() }
      assertSame("Service destruction must preserve the process session", session, PlayerHost.session)
      val replacement = Robolectric.buildService(PlayerMediaService::class.java).create()
      try {
        replacement.get().onStartCommand(Intent(context, PlayerMediaService::class.java), 0, 2)
        RobolectricUtil.runMainLooperUntil { session.connectedControllers.isNotEmpty() }
        assertSame(session, replacement.get().sessions.single())
      } finally { replacement.destroy() }
    } finally { owner.stopAll() }
  }
}
