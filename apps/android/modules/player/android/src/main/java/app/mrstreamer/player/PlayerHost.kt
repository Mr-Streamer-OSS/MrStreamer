package app.mrstreamer.player

import android.content.Context
import android.os.Looper
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.MediaSession

/**
 * The process's one player and its one MediaSession, made on first use on the main thread. Every
 * screen, and later the media notification and picture-in-picture, uses this owner; nothing else
 * makes an ExoPlayer.
 */
@UnstableApi
object PlayerHost {
  private var owner: PlayerOwner? = null

  /** The media session over [owner]'s player, for media controls and notifications. */
  var session: MediaSession? = null
    private set

  fun owner(context: Context): PlayerOwner {
    check(Looper.myLooper() == Looper.getMainLooper()) { "The player is used on the main thread" }
    owner?.let { return it }
    val app = context.applicationContext
    val player =
      ExoPlayer.Builder(app)
        .setLooper(Looper.getMainLooper())
        .setAudioAttributes(
          AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MOVIE).build(),
          /* handleAudioFocus= */ true,
        )
        .setHandleAudioBecomingNoisy(true)
        .build()
    session = MediaSession.Builder(app, player).setId("player").build()
    return PlayerOwner(app, player).also { owner = it }
  }
}
