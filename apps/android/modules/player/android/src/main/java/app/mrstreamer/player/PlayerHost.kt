package app.mrstreamer.player

import android.content.Context
import android.os.Looper
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
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
    session = MediaSession.Builder(app, player).setId("player").setCallback(OwnerCommands).build()
    return PlayerOwner(app, player).also { owner = it }
  }

  /**
   * Media buttons and system controls may play, pause and seek; what ends or changes an attempt
   * (stop, prepare, a new item) stays with [PlayerOwner], which reports and releases it.
   */
  private object OwnerCommands : MediaSession.Callback {
    override fun onConnect(session: MediaSession, controller: MediaSession.ControllerInfo) =
      MediaSession.ConnectionResult.AcceptedResultBuilder(session)
        .setAvailablePlayerCommands(
          MediaSession.ConnectionResult.DEFAULT_PLAYER_COMMANDS.buildUpon()
            .removeAll(
              Player.COMMAND_STOP,
              Player.COMMAND_PREPARE,
              Player.COMMAND_SET_MEDIA_ITEM,
              Player.COMMAND_CHANGE_MEDIA_ITEMS,
              Player.COMMAND_SEEK_TO_NEXT,
              Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM,
              Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM,
              Player.COMMAND_SET_SPEED_AND_PITCH,
              Player.COMMAND_SET_TRACK_SELECTION_PARAMETERS,
            )
            .build(),
        )
        .build()
  }
}
