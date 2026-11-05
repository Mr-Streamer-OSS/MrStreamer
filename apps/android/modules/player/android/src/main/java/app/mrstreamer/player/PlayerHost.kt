package app.mrstreamer.player

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Bundle
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.MediaMetadata
import androidx.media3.common.TrackSelectionParameters
import androidx.media3.session.CommandButton
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionResult
import com.google.common.util.concurrent.Futures
import android.os.Looper
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.ForwardingPlayer
import androidx.media3.common.Player
import androidx.media3.common.Timeline
import androidx.media3.exoplayer.source.ForwardingTimeline
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.MediaSession
import androidx.media3.session.SessionCommands

/** One process player; normal playback retains its session across replacements, previews suppress it. */
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
    val launch = app.packageManager.getLaunchIntentForPackage(app.packageName)
      .let { it ?: Intent().setClassName(app.packageName, "${app.packageName}.MainActivity") }
      .setAction(Intent.ACTION_VIEW).setData(android.net.Uri.parse("mrstreamer://watch"))
    fun ensureSession() {
      if (session != null) return
      session = MediaSession.Builder(app, OwnerPlayer(player, made)).setId("player")
      .setSessionActivity(PendingIntent.getActivity(app, 0, launch, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
      .setCallback(object : MediaSession.Callback {
        override fun onConnect(session: MediaSession, controller: MediaSession.ControllerInfo) =
          MediaSession.ConnectionResult.accept(sessionCommands(made.live, made.nextAvailable), commands(made.live, made.nextAvailable))
        override fun onCustomCommand(session: MediaSession, controller: MediaSession.ControllerInfo, command: SessionCommand, args: Bundle) = Futures.immediateFuture(
          if (sessionCommands(made.live, made.nextAvailable).contains(command)) {
            when (command.customAction) {
              "back" -> made.jump(-10_000)
              "forward" -> made.jump(10_000)
              "next" -> made.mediaCommand("next")
              "close" -> made.stopAll()
            }
            SessionResult(SessionResult.RESULT_SUCCESS)
          } else SessionResult(SessionResult.RESULT_ERROR_NOT_SUPPORTED)
        )
      }).build()
    }
    made.changed = {
      if (made.preview) {
        session?.release()
        session = null
      } else if (made.attempt != null) ensureSession()
      session?.let { media ->
        for (controller in media.connectedControllers) {
          media.setAvailableCommands(controller, sessionCommands(made.live, made.nextAvailable), commands(made.live, made.nextAvailable))
        }
      }
      session?.setMediaButtonPreferences(buttons(app, made.live, made.nextAvailable))
      PlayerPip.refresh()
      if (made.attempt != null && !made.preview && !serviceStarted) {
        try {
          app.startService(Intent(app, PlayerMediaService::class.java))
          serviceStarted = true
        } catch (_: IllegalStateException) { serviceStarted = false }
          catch (_: SecurityException) { serviceStarted = false }
      } else if ((made.attempt == null || made.preview) && serviceStarted) {
        app.stopService(Intent(app, PlayerMediaService::class.java))
        serviceStarted = false
      }
    }
    return made
  }

  /** Reconcile only after the old service has detached and completed its teardown. */
  fun serviceDestroyed() {
    serviceStarted = false
    owner?.changed?.invoke()
  }

  fun sessionCommands(live: Boolean, next: Boolean): SessionCommands = SessionCommands.Builder().apply {
    add(SessionCommand("close", Bundle.EMPTY))
    if (!live) {
      add(SessionCommand("back", Bundle.EMPTY)); add(SessionCommand("forward", Bundle.EMPTY))
      if (next) add(SessionCommand("next", Bundle.EMPTY))
    }
  }.build()

  private fun buttons(context: Context, live: Boolean, next: Boolean): List<CommandButton> = buildList {
    fun button(action: String, label: Int, icon: Int) = CommandButton.Builder(icon)
      .setDisplayName(context.getString(label)).setSessionCommand(SessionCommand(action, Bundle.EMPTY)).build()
    if (!live) {
      add(button("back", app.mrstreamer.playback.R.string.player_back, CommandButton.ICON_SKIP_BACK_10))
      add(button("forward", app.mrstreamer.playback.R.string.player_forward, CommandButton.ICON_SKIP_FORWARD_10))
      if (next) add(button("next", app.mrstreamer.playback.R.string.player_next, CommandButton.ICON_NEXT))
    }
    add(button("close", app.mrstreamer.playback.R.string.player_close, CommandButton.ICON_STOP))
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
    private val listeners = java.util.IdentityHashMap<Player.Listener, Player.Listener>()

    // Build from an allowlist: playback configuration and request metadata stay with ExoPlayer.
    private fun publicItem(item: MediaItem) = MediaItem.Builder()
      .setMediaId(item.mediaId)
      .setMediaMetadata(MediaMetadata.Builder().setTitle(item.mediaMetadata.title).build())
      .build()

    private fun publicTimeline(timeline: Timeline): Timeline = object : ForwardingTimeline(timeline) {
      override fun getWindow(index: Int, window: Timeline.Window, projectionUs: Long): Timeline.Window =
        super.getWindow(index, window, projectionUs).apply {
          mediaItem = publicItem(mediaItem)
          manifest = null
        }
    }

    private fun publicPosition(position: Player.PositionInfo) = Player.PositionInfo(
      position.windowUid, position.mediaItemIndex, position.mediaItem?.let(::publicItem),
      position.periodUid, position.periodIndex, position.positionMs, position.contentPositionMs,
      position.adGroupIndex, position.adIndexInAdGroup)

    override fun getCurrentMediaItem() = super.getCurrentMediaItem()?.let(::publicItem)
    override fun getMediaItemAt(index: Int) = publicItem(super.getMediaItemAt(index))
    override fun getCurrentTimeline() = publicTimeline(super.getCurrentTimeline())

    // Session updates also carry items; sanitizing getters alone would leak on replacement.
    override fun addListener(listener: Player.Listener) {
      if (listeners.containsKey(listener)) return
      val wrapped = object : Player.Listener {
        // Java default methods need explicit forwarding in Kotlin, including metadata and onEvents.
        override fun onEvents(player: Player, events: Player.Events) = listener.onEvents(player, events)
        override fun onTracksChanged(tracks: androidx.media3.common.Tracks) = listener.onTracksChanged(tracks)
        override fun onMediaMetadataChanged(mediaMetadata: MediaMetadata) = listener.onMediaMetadataChanged(mediaMetadata)
        override fun onPlaylistMetadataChanged(mediaMetadata: MediaMetadata) = listener.onPlaylistMetadataChanged(mediaMetadata)
        override fun onIsLoadingChanged(isLoading: Boolean) = listener.onIsLoadingChanged(isLoading)
        override fun onLoadingChanged(isLoading: Boolean) = listener.onLoadingChanged(isLoading)
        override fun onAvailableCommandsChanged(availableCommands: Player.Commands) = listener.onAvailableCommandsChanged(availableCommands)
        override fun onTrackSelectionParametersChanged(parameters: TrackSelectionParameters) = listener.onTrackSelectionParametersChanged(parameters)
        override fun onPlayerStateChanged(playWhenReady: Boolean, playbackState: Int) = listener.onPlayerStateChanged(playWhenReady, playbackState)
        override fun onPlaybackStateChanged(playbackState: Int) = listener.onPlaybackStateChanged(playbackState)
        override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) = listener.onPlayWhenReadyChanged(playWhenReady, reason)
        override fun onPlaybackSuppressionReasonChanged(playbackSuppressionReason: Int) = listener.onPlaybackSuppressionReasonChanged(playbackSuppressionReason)
        override fun onIsPlayingChanged(isPlaying: Boolean) = listener.onIsPlayingChanged(isPlaying)
        override fun onRepeatModeChanged(repeatMode: Int) = listener.onRepeatModeChanged(repeatMode)
        override fun onShuffleModeEnabledChanged(shuffleModeEnabled: Boolean) = listener.onShuffleModeEnabledChanged(shuffleModeEnabled)
        override fun onPlayerError(error: androidx.media3.common.PlaybackException) = listener.onPlayerError(error)
        override fun onPlayerErrorChanged(error: androidx.media3.common.PlaybackException?) = listener.onPlayerErrorChanged(error)
        override fun onPositionDiscontinuity(reason: Int) = listener.onPositionDiscontinuity(reason)
        override fun onPlaybackParametersChanged(playbackParameters: PlaybackParameters) = listener.onPlaybackParametersChanged(playbackParameters)
        override fun onSeekBackIncrementChanged(seekBackIncrementMs: Long) = listener.onSeekBackIncrementChanged(seekBackIncrementMs)
        override fun onSeekForwardIncrementChanged(seekForwardIncrementMs: Long) = listener.onSeekForwardIncrementChanged(seekForwardIncrementMs)
        override fun onMaxSeekToPreviousPositionChanged(maxSeekToPreviousPositionMs: Long) = listener.onMaxSeekToPreviousPositionChanged(maxSeekToPreviousPositionMs)
        override fun onAudioSessionIdChanged(audioSessionId: Int) = listener.onAudioSessionIdChanged(audioSessionId)
        override fun onAudioAttributesChanged(audioAttributes: AudioAttributes) = listener.onAudioAttributesChanged(audioAttributes)
        override fun onVolumeChanged(volume: Float) = listener.onVolumeChanged(volume)
        override fun onSkipSilenceEnabledChanged(skipSilenceEnabled: Boolean) = listener.onSkipSilenceEnabledChanged(skipSilenceEnabled)
        override fun onDeviceInfoChanged(deviceInfo: androidx.media3.common.DeviceInfo) = listener.onDeviceInfoChanged(deviceInfo)
        override fun onDeviceVolumeChanged(volume: Int, muted: Boolean) = listener.onDeviceVolumeChanged(volume, muted)
        override fun onVideoSizeChanged(videoSize: androidx.media3.common.VideoSize) = listener.onVideoSizeChanged(videoSize)
        override fun onSurfaceSizeChanged(width: Int, height: Int) = listener.onSurfaceSizeChanged(width, height)
        override fun onRenderedFirstFrame() = listener.onRenderedFirstFrame()
        override fun onCues(cues: List<androidx.media3.common.text.Cue>) = listener.onCues(cues)
        override fun onCues(cueGroup: androidx.media3.common.text.CueGroup) = listener.onCues(cueGroup)
        override fun onMetadata(metadata: androidx.media3.common.Metadata) = listener.onMetadata(metadata)
        override fun onTimelineChanged(timeline: Timeline, reason: Int) =
          listener.onTimelineChanged(publicTimeline(timeline), reason)
        override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) =
          listener.onMediaItemTransition(mediaItem?.let(::publicItem), reason)
        override fun onPositionDiscontinuity(old: Player.PositionInfo, new: Player.PositionInfo, reason: Int) =
          listener.onPositionDiscontinuity(publicPosition(old), publicPosition(new), reason)
      }
      listeners[listener] = wrapped
      super.addListener(wrapped)
    }

    override fun removeListener(listener: Player.Listener) {
      listeners.remove(listener)?.let { super.removeListener(it) }
    }

    override fun mute() {}
    override fun unmute() {}
    override fun setDeviceVolume(volume: Int) {}
    override fun setDeviceVolume(volume: Int, flags: Int) {}
    override fun increaseDeviceVolume() {}
    override fun increaseDeviceVolume(flags: Int) {}
    override fun decreaseDeviceVolume() {}
    override fun decreaseDeviceVolume(flags: Int) {}
    override fun setDeviceMuted(muted: Boolean) {}
    override fun setDeviceMuted(muted: Boolean, flags: Int) {}
    override fun clearVideoSurface() {}
    override fun clearVideoSurface(surface: android.view.Surface?) {}
    override fun setVideoSurface(surface: android.view.Surface?) {}
    override fun setVideoSurfaceHolder(surfaceHolder: android.view.SurfaceHolder?) {}
    override fun clearVideoSurfaceHolder(surfaceHolder: android.view.SurfaceHolder?) {}
    override fun setVideoSurfaceView(surfaceView: android.view.SurfaceView?) {}
    override fun clearVideoSurfaceView(surfaceView: android.view.SurfaceView?) {}
    override fun setVideoTextureView(textureView: android.view.TextureView?) {}
    override fun clearVideoTextureView(textureView: android.view.TextureView?) {}
    override fun prepare() {}
    override fun release() {}
    override fun setMediaItem(mediaItem: MediaItem) {}
    override fun setMediaItem(mediaItem: MediaItem, resetPosition: Boolean) {}
    override fun setMediaItem(mediaItem: MediaItem, startPositionMs: Long) {}
    override fun setMediaItems(mediaItems: MutableList<MediaItem>) {}
    override fun setMediaItems(mediaItems: MutableList<MediaItem>, resetPosition: Boolean) {}
    override fun setMediaItems(mediaItems: MutableList<MediaItem>, startIndex: Int, startPositionMs: Long) {}
    override fun addMediaItem(mediaItem: MediaItem) {}
    override fun addMediaItem(index: Int, mediaItem: MediaItem) {}
    override fun addMediaItems(mediaItems: MutableList<MediaItem>) {}
    override fun addMediaItems(index: Int, mediaItems: MutableList<MediaItem>) {}
    override fun moveMediaItem(currentIndex: Int, newIndex: Int) {}
    override fun moveMediaItems(fromIndex: Int, toIndex: Int, newIndex: Int) {}
    override fun replaceMediaItem(index: Int, mediaItem: MediaItem) {}
    override fun replaceMediaItems(fromIndex: Int, toIndex: Int, mediaItems: MutableList<MediaItem>) {}
    override fun removeMediaItem(index: Int) {}
    override fun removeMediaItems(fromIndex: Int, toIndex: Int) {}
    override fun clearMediaItems() {}
    override fun setPlaybackParameters(playbackParameters: PlaybackParameters) {}
    override fun setPlaybackSpeed(speed: Float) {}
    override fun setTrackSelectionParameters(parameters: TrackSelectionParameters) {}
    override fun setRepeatMode(repeatMode: Int) {}
    override fun setShuffleModeEnabled(shuffleModeEnabled: Boolean) {}
    override fun setVolume(volume: Float) {}
    override fun setAudioAttributes(audioAttributes: AudioAttributes, handleAudioFocus: Boolean) {}
    override fun setPlaylistMetadata(mediaMetadata: MediaMetadata) {}
    override fun seekToDefaultPosition() {}
    override fun seekToDefaultPosition(mediaItemIndex: Int) {}
    override fun seekToPrevious() {}
    override fun seekToPreviousMediaItem() {}
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
