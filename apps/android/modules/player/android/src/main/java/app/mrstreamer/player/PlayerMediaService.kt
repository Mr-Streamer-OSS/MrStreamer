package app.mrstreamer.player

import android.content.Intent
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService

/** Hosts the existing session; never constructs another player. */
@UnstableApi
class PlayerMediaService : MediaSessionService() {
  override fun onCreate() {
    super.onCreate()
    PlayerHost.session?.let { addSession(it) }
  }
  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    PlayerHost.session?.let { addSession(it) }
    return super.onStartCommand(intent, flags, startId)
  }
  override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = PlayerHost.session
  override fun onDestroy() {
    // The session outlives this service. Detach its notification controller before teardown
    // so later playback cannot issue foreground starts from the destroyed service instance.
    sessions.forEach { removeSession(it) }
    super.onDestroy()
  }
  override fun onTaskRemoved(rootIntent: Intent?) {
    PlayerHost.existing()?.stopAll()
    stopSelf()
  }
}
