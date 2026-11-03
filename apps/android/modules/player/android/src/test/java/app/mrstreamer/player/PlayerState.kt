package app.mrstreamer.player

import android.app.Activity
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import java.lang.ref.WeakReference

/** Release the process owner and reset lifecycle state between Robolectric applications. */
@UnstableApi
fun resetPlayerState() {
  PlayerHost.existing()?.let { owner ->
    owner.stopAll()
    PlayerHost.session?.release()
    val field = PlayerOwner::class.java.getDeclaredField("player").apply { isAccessible = true }
    (field.get(owner) as ExoPlayer).release()
  }
  fun set(target: Any, name: String, value: Any?) {
    target.javaClass.getDeclaredField(name).apply { isAccessible = true }.set(target, value)
  }
  set(PlayerHost, "session", null)
  set(PlayerHost, "owner", null)
  set(PlayerHost, "serviceStarted", false)
  set(PlayerPip, "activity", WeakReference<Activity>(null))
  for (name in listOf("watch", "pip", "leavingPip")) set(PlayerPip, name, false)
  set(PlayerPip, "stopped", true)
}
