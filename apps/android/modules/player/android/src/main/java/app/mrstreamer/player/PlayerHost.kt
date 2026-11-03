package app.mrstreamer.player

import android.content.Context
import android.os.Looper
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.ForwardingPlayer
import androidx.media3.common.Player
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
  private var session: MediaSession? = null

  /** The owner if one was made, without making one. */
  fun existing(): PlayerOwner? = owner

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
    val made = PlayerOwner(player)
    session = MediaSession.Builder(app, OwnerPlayer(player, made)).setId("player").setCallback(OwnerCommands).build()
    return made.also { owner = it }
  }

  /** Play from a media button or system control goes through the owner, as Watch's does. */
  private class OwnerPlayer(player: Player, private val owner: PlayerOwner) : ForwardingPlayer(player) {
    override fun play() = owner.resumeCurrent()
  }

  /**
   * Media buttons and system controls may play and pause. What ends, changes or moves an attempt
   * (stop, prepare, a new item, seeking, speed, repeat) stays with [PlayerOwner], whose rules (Live
   * never seeks) a controller would otherwise go around.
   */
  private object OwnerCommands : MediaSession.Callback {
    override fun onConnect(session: MediaSession, controller: MediaSession.ControllerInfo) =
      MediaSession.ConnectionResult.accept(
        MediaSession.ConnectionResult.DEFAULT_SESSION_COMMANDS,
        Player.Commands.Builder()
          .addAll(
            Player.COMMAND_PLAY_PAUSE,
            Player.COMMAND_GET_CURRENT_MEDIA_ITEM,
            Player.COMMAND_GET_TIMELINE,
            Player.COMMAND_GET_METADATA,
            Player.COMMAND_GET_AUDIO_ATTRIBUTES,
            Player.COMMAND_GET_TRACKS,
          )
          .build(),
      )
  }
}
