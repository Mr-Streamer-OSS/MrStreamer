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
  override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = PlayerHost.session
  override fun onTaskRemoved(rootIntent: Intent?) {
    PlayerHost.existing()?.stopAll()
    stopSelf()
  }
}
