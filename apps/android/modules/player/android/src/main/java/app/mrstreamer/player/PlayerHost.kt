package app.mrstreamer.player

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Looper
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.ForwardingPlayer
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.MediaSession
import androidx.media3.session.SessionCommands

/** The process owns one player and one session, including across Activity recreation. */
@UnstableApi
object PlayerHost {
  private var owner: PlayerOwner? = null
  private var serviceStarted = false
  var session: MediaSession? = null
    private set

  fun existing(): PlayerOwner? = owner

  fun owner(context: Context): PlayerOwner {
    check(Looper.myLooper() == Looper.getMainLooper())
    owner?.let { return it }
    val app = context.applicationContext
    val player = ExoPlayer.Builder(app)
      .setSeekBackIncrementMs(10_000).setSeekForwardIncrementMs(10_000)
      .setAudioAttributes(AudioAttributes.Builder().setUsage(C.USAGE_MEDIA)
        .setContentType(C.AUDIO_CONTENT_TYPE_MOVIE).build(), true)
      .setHandleAudioBecomingNoisy(true).build()
    val made = PlayerOwner(player)
    owner = made
    val launch = app.packageManager.getLaunchIntentForPackage(app.packageName)!!
      .setAction(Intent.ACTION_VIEW).setData(android.net.Uri.parse("mrstreamer://watch"))
    session = MediaSession.Builder(app, OwnerPlayer(player, made)).setId("player")
      .setSessionActivity(PendingIntent.getActivity(app, 0, launch, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
      .setCallback(object : MediaSession.Callback {
        override fun onConnect(session: MediaSession, controller: MediaSession.ControllerInfo) =
          MediaSession.ConnectionResult.accept(SessionCommands.EMPTY, commands(made.live, made.nextAvailable))
      }).build()
    made.changed = {
      session?.let { media ->
        for (controller in media.connectedControllers) {
          media.setAvailableCommands(controller, SessionCommands.EMPTY, commands(made.live, made.nextAvailable))
        }
      }
      PlayerPip.refresh()
      if (made.attempt != null && !serviceStarted) {
        app.startService(Intent(app, PlayerMediaService::class.java))
        serviceStarted = true
      } else if (made.attempt == null && serviceStarted) {
        app.stopService(Intent(app, PlayerMediaService::class.java))
        serviceStarted = false
      }
    }
    return made
  }

  /** Only playback controls and read-only metadata leave the owner. */
  fun commands(live: Boolean, next: Boolean): Player.Commands = Player.Commands.Builder()
    .addAll(Player.COMMAND_PLAY_PAUSE, Player.COMMAND_STOP, Player.COMMAND_GET_CURRENT_MEDIA_ITEM,
      Player.COMMAND_GET_TIMELINE, Player.COMMAND_GET_METADATA, Player.COMMAND_GET_AUDIO_ATTRIBUTES)
    .apply {
      if (!live) {
        addAll(Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM, Player.COMMAND_SEEK_BACK, Player.COMMAND_SEEK_FORWARD)
        if (next) addAll(Player.COMMAND_SEEK_TO_NEXT, Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM)
      }
    }.build()

  private class OwnerPlayer(player: Player, private val owner: PlayerOwner) : ForwardingPlayer(player) {
    override fun getAvailableCommands() = commands(owner.live, owner.nextAvailable)
    override fun isCommandAvailable(command: Int) = availableCommands.contains(command)
    override fun play() = owner.resumeCurrent()
    override fun pause() = owner.pauseCurrent()
    override fun setPlayWhenReady(playWhenReady: Boolean) { if (playWhenReady) owner.resumeCurrent() else owner.pauseCurrent() }
    override fun stop() = owner.stopAll()
    override fun seekTo(positionMs: Long) { owner.attempt?.let { owner.seek(it, positionMs) } }
    override fun seekTo(mediaItemIndex: Int, positionMs: Long) { if (mediaItemIndex == currentMediaItemIndex) seekTo(positionMs) }
    override fun seekBack() = owner.jump(-10_000)
    override fun seekForward() = owner.jump(10_000)
    override fun seekToNext() { if (!owner.live && owner.nextAvailable) owner.mediaCommand("next") }
    override fun seekToNextMediaItem() = seekToNext()
  }
}
