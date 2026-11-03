package app.mrstreamer.player

import android.net.Uri
import android.os.Handler
import android.os.Looper
import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.Tracks
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.datasource.FileDataSource
import androidx.media3.datasource.HttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.extractor.DefaultExtractorsFactory
import androidx.media3.extractor.ts.DefaultTsPayloadReaderFactory
import androidx.media3.ui.PlayerView
import java.io.File

/** Where an attempt's media comes from: a saved source's provider, or a file on this phone. */
sealed interface HoldRef {
  data class Source(val sourceId: String) : HoldRef
  data class LocalFile(val path: String) : HoldRef
}

/**
 * One request to play. [attempt] names it in every command and observation, so neither a late
 * command nor a late observation of an attempt that was replaced can act on its successor.
 * [url] and [headers] can hold a login: they are used for the request and never reported back.
 */
data class Admission(
  val attempt: String,
  val url: String,
  val headers: Map<String, String>,
  /** "hls", "mpegts", or "progressive" for a file whose container the reader recognises. */
  val format: String,
  /** "live", "archive", "title" or "file". */
  val mode: String,
  /** Where a title, recording or file starts, in ms; live starts at its live edge. */
  val startMs: Long,
  val hold: HoldRef,
)

enum class Phase { PREPARING, BUFFERING, PLAYING, PAUSED, ENDED, FAILED, STOPPED }

/** Why an attempt failed, without its address: [kind] is what JS shows, [code] Media3's name. */
data class Failure(val kind: String, val code: String, val status: Int? = null)

/** What the player observed of the current attempt. Positions are ms; null when not known. */
data class Observation(
  val attempt: String,
  val phase: Phase,
  val positionMs: Long,
  val durationMs: Long?,
  val bufferedMs: Long,
  val live: Boolean,
  val seekable: Boolean,
  val speed: Float,
  val failure: Failure?,
)

/** A track the media declares, and whether this phone's decoders can play it. */
data class Track(
  /** "<group>:<track>", stable while the attempt plays; pass it back to choose it. */
  val id: String,
  val type: String,
  val codec: String?,
  val language: String?,
  val label: String?,
  val width: Int?,
  val height: Int?,
  val bitrate: Int?,
  val channels: Int?,
  val selected: Boolean,
  val supported: Boolean,
)

/**
 * How an attempt's hold ended. "file-closed": its file is no longer open. "connections-closed":
 * this phone closed every connection it opened; whether the provider has counted them as ended is
 * not observable from here. "unconfirmed": a reader was still open [RELEASE_TIMEOUT_MS] after
 * the attempt ended.
 */
data class Release(val attempt: String, val hold: HoldRef, val outcome: String)

interface PlayerEvents {
  fun observed(observation: Observation)
  fun tracks(attempt: String, tracks: List<Track>)
  fun released(release: Release)
}

/**
 * The app's one player: a single ExoPlayer that plays one attempt at a time and shows its picture
 * in the newest attached [PlayerView], so Watch and the mini player share it and leaving one for
 * the other never restarts playback. Admitting an attempt replaces the one before; commands name
 * their attempt and are refused (false) for any other. Use it on [Looper.getMainLooper].
 */
@UnstableApi
class PlayerOwner(
  private val player: ExoPlayer,
  var events: PlayerEvents? = null,
) {
  private class Current(val admission: Admission, val hold: Hold) {
    var stopped = false
    /** Why it failed, until it plays again. */
    var failure: Failure? = null
  }

  private val main = Handler(player.applicationLooper)
  private var current: Current? = null
  private val views = ArrayDeque<PlayerView>()
  private val tick = object : Runnable {
    override fun run() {
      observe()
      if (player.isPlaying) main.postDelayed(this, TICK_MS)
    }
  }

  private val extractors =
    DefaultExtractorsFactory()
      .setConstantBitrateSeekingEnabled(true)
      .setTsExtractorFlags(DefaultTsPayloadReaderFactory.FLAG_ALLOW_NON_IDR_KEYFRAMES)

  init {
    player.addListener(
      object : Player.Listener {
        override fun onEvents(player: Player, events: Player.Events) {
          if (!ownsCurrentItem()) return
          if (events.contains(Player.EVENT_TRACKS_CHANGED)) reportTracks()
          if (events.contains(Player.EVENT_IS_PLAYING_CHANGED)) {
            main.removeCallbacks(tick)
            if (player.isPlaying) main.postDelayed(tick, TICK_MS)
            views.lastOrNull()?.keepScreenOn = player.isPlaying
          }
          if (
            events.containsAny(
              Player.EVENT_PLAYBACK_STATE_CHANGED,
              Player.EVENT_PLAY_WHEN_READY_CHANGED,
              Player.EVENT_POSITION_DISCONTINUITY,
              Player.EVENT_TIMELINE_CHANGED,
              Player.EVENT_PLAYBACK_PARAMETERS_CHANGED,
              Player.EVENT_IS_PLAYING_CHANGED,
              Player.EVENT_PLAYBACK_SUPPRESSION_REASON_CHANGED,
            )
          ) observe()
        }

        override fun onPlayerError(error: PlaybackException) {
          if (!ownsCurrentItem()) return
          if (error.errorCode == PlaybackException.ERROR_CODE_BEHIND_LIVE_WINDOW) {
            player.seekToDefaultPosition()
            player.prepare()
            return
          }
          observe(failureOf(error))
        }
      },
    )
  }

  /** Plays [admission], replacing what played before. */
  fun admit(admission: Admission) {
    val ending = end()
    val hold =
      Hold(main) { closed ->
        events?.released(Release(admission.attempt, admission.hold, if (closed) outcomeOf(admission) else "unconfirmed"))
      }
    current = Current(admission, hold)
    val local = admission.hold as? HoldRef.LocalFile
    if (local != null && !File(local.path).isFile) {
      player.stop()
      player.clearMediaItems()
      ending?.let(::letGo)
      observe(Failure("file-missing", "ERROR_CODE_IO_FILE_NOT_FOUND"))
      return
    }
    try {
      prepare(admission, hold, local)
    } catch (error: RuntimeException) {
      // Nothing of the new attempt plays, and nothing of the old one may linger unreleased.
      current = null
      player.stop()
      player.clearMediaItems()
      ending?.let(::letGo)
      hold.retire()
      throw error
    }
    // Only now that its media is no longer the player's can what the last attempt held settle.
    ending?.let(::letGo)
    player.setPlaybackSpeed(1f)
    player.trackSelectionParameters =
      player.trackSelectionParameters.buildUpon().clearOverridesOfType(C.TRACK_TYPE_VIDEO).build()
    player.playWhenReady = true
    player.prepare()
    observe()
  }

  /** Gives the player [admission]'s media, read through [hold]. */
  private fun prepare(admission: Admission, hold: Hold, local: HoldRef.LocalFile?) {
    val http =
      DefaultHttpDataSource.Factory()
        // An http address may move to https; an https one never moves to http, where its login
        // would travel in the clear (core's providerFetch holds the app's other requests to that).
        .setAllowCrossProtocolRedirects(Uri.parse(admission.url).scheme == "http")
        .setConnectTimeoutMs(CONNECT_TIMEOUT_MS)
        .setReadTimeoutMs(READ_TIMEOUT_MS)
        .setDefaultRequestProperties(admission.headers)
    admission.headers.entries.firstOrNull { it.key.equals("User-Agent", ignoreCase = true) }?.let {
      http.setUserAgent(it.value)
    }
    val item =
      MediaItem.Builder()
        .setUri(if (local != null) Uri.fromFile(File(local.path)) else Uri.parse(admission.url))
        .setMediaId(admission.attempt)
        .setMimeType(
          when (admission.format) {
            "hls" -> MimeTypes.APPLICATION_M3U8
            "mpegts" -> MimeTypes.VIDEO_MP2T
            else -> null
          },
        )
        .build()
    // A file reads only files and a source only its provider's addresses (see [allows]).
    val upstream = if (local != null) FileDataSource.Factory() else http
    val source =
      DefaultMediaSourceFactory(hold.factory(upstream) { allows(admission, it) }, extractors).createMediaSource(item)
    if (admission.mode == "live") player.setMediaSource(source) else player.setMediaSource(source, admission.startMs)
  }

  fun pause(attempt: String) = command(attempt, ::ownsCurrentItem) { player.pause() }

  /** Plays on; Live rejoins its live edge, an ended title starts again, a failed one tries again. */
  fun resume(attempt: String) =
    command(attempt, ::ownsCurrentItem) {
      if (current?.admission?.mode == "live") player.seekToDefaultPosition()
      else if (player.playbackState == Player.STATE_ENDED) player.seekTo(0)
      if (player.playbackState == Player.STATE_IDLE) player.prepare()
      player.play()
    }

  fun seek(attempt: String, positionMs: Long) =
    command(attempt, { ownsCurrentItem() && seekable() }) { player.seekTo(positionMs.coerceAtLeast(0)) }

  fun setSpeed(attempt: String, speed: Float) =
    command(attempt, { current?.admission?.mode != "live" && speed in 0.25f..4f }) {
      player.setPlaybackSpeed(speed)
    }

  /** Plays the video track [trackId] from the reported tracks, or chooses by itself again for null. */
  fun setQuality(attempt: String, trackId: String?): Boolean {
    if (trackId == null) {
      return command(attempt) {
        player.trackSelectionParameters =
          player.trackSelectionParameters.buildUpon().clearOverridesOfType(C.TRACK_TYPE_VIDEO).build()
      }
    }
    val (groupIndex, trackIndex) = trackId.split(":").mapNotNull { it.toIntOrNull() }.takeIf { it.size == 2 } ?: return false
    val group = player.currentTracks.groups.getOrNull(groupIndex) ?: return false
    val valid = group.type == C.TRACK_TYPE_VIDEO && trackIndex in 0 until group.length && group.isTrackSupported(trackIndex)
    return command(attempt, { valid }) {
      player.trackSelectionParameters =
        player.trackSelectionParameters
          .buildUpon()
          .setOverrideForType(TrackSelectionOverride(group.mediaTrackGroup, trackIndex))
          .build()
    }
  }

  /** Ends [attempt], reporting where it stopped, and releases what it held. */
  fun stop(attempt: String) =
    command(attempt) {
      observe()
      val ending = end()
      player.stop()
      player.clearMediaItems()
      ending?.let(::letGo)
    }

  /** Plays on whatever plays, as a media button asks: nothing when nothing does. */
  fun resumeCurrent() {
    current?.let { resume(it.admission.attempt) }
  }

  /** Ends whatever plays, as when the app's JS goes away. */
  fun stopAll() {
    current?.let { stop(it.admission.attempt) }
  }

  /** Shows the picture in [view], the newest of those attached. */
  fun attach(view: PlayerView) {
    val previous = views.lastOrNull()
    views.remove(view)
    views.addLast(view)
    PlayerView.switchTargetView(player, previous, view)
    view.keepScreenOn = player.isPlaying
  }

  /** Stops showing the picture in [view]; the newest still attached shows it instead. */
  fun detach(view: PlayerView) {
    val wasShowing = views.lastOrNull() === view
    views.remove(view)
    view.keepScreenOn = false
    if (wasShowing) PlayerView.switchTargetView(player, view, views.lastOrNull())
    else if (view.player === player) view.player = null
    views.lastOrNull()?.keepScreenOn = player.isPlaying
  }

  private fun command(attempt: String, allowed: () -> Boolean = { true }, action: () -> Unit): Boolean {
    val now = current ?: return false
    if (now.admission.attempt != attempt || now.stopped || !allowed()) return false
    action()
    return true
  }

  /** Reports the current attempt's last position as stopped, and returns it for [letGo]. */
  private fun end(): Current? {
    val ending = current ?: return null
    if (!ending.stopped) {
      ending.stopped = true
      main.removeCallbacks(tick)
      events?.observed(observationOf(ending.admission, Phase.STOPPED, null))
    }
    current = null
    return ending
  }

  /**
   * Settles what [ending] held once the player no longer has its media: no reader of it opens
   * after this, and the release is reported when the last open one closes.
   */
  private fun letGo(ending: Current) {
    ending.hold.retire()
    main.postDelayed({ ending.hold.timeOut() }, RELEASE_TIMEOUT_MS)
  }

  /** Live plays at its live edge: going back in a channel is catch-up's, a mode of its own. */
  private fun seekable() = current?.admission?.mode != "live" && player.isCurrentMediaItemSeekable

  private fun ownsCurrentItem(): Boolean {
    val now = current ?: return false
    return !now.stopped && player.currentMediaItem?.mediaId == now.admission.attempt
  }

  private fun observe(failure: Failure? = null) {
    val now = current ?: return
    if (now.stopped) return
    if (failure != null) now.failure = failure
    else if (player.playbackState != Player.STATE_IDLE) now.failure = null
    // A live stream has no end: one that ends lost its connection to the provider.
    if (player.playbackState == Player.STATE_ENDED && now.admission.mode == "live") {
      now.failure = Failure("network", "STREAM_ENDED")
    }
    val phase =
      when {
        now.failure != null -> Phase.FAILED
        player.playbackState == Player.STATE_ENDED -> Phase.ENDED
        player.playbackState == Player.STATE_IDLE -> Phase.PREPARING
        player.isPlaying -> Phase.PLAYING
        player.playbackState == Player.STATE_BUFFERING && player.playWhenReady ->
          if (player.duration == C.TIME_UNSET && player.currentPosition == 0L) Phase.PREPARING else Phase.BUFFERING
        else -> Phase.PAUSED
      }
    events?.observed(observationOf(now.admission, phase, now.failure))
  }

  private fun observationOf(admission: Admission, phase: Phase, failure: Failure?) =
    Observation(
      attempt = admission.attempt,
      phase = phase,
      positionMs = player.currentPosition.coerceAtLeast(0),
      durationMs = player.duration.takeIf { it != C.TIME_UNSET && admission.mode != "live" },
      bufferedMs = player.totalBufferedDuration,
      // A recording is never live, whatever its playlist says: Live and catch-up stay apart.
      live = admission.mode == "live",
      seekable = admission.mode != "live" && player.isCurrentMediaItemSeekable,
      speed = player.playbackParameters.speed,
      failure = failure,
    )

  private fun reportTracks() {
    val now = current ?: return
    val tracks = tracksOf(player.currentTracks)
    events?.tracks(now.admission.attempt, tracks)
    val declared = tracks.filter { it.type == "video" || it.type == "audio" }
    // Media that declares picture or sound none of which this phone can play is a failure, not
    // silence: say so instead of showing a black screen.
    if (declared.isNotEmpty() && declared.none { it.supported }) {
      observe(Failure("unsupported", "ERROR_CODE_DECODING_FORMAT_UNSUPPORTED"))
      player.stop()
    }
  }

  private fun outcomeOf(admission: Admission) =
    if (admission.hold is HoldRef.LocalFile) "file-closed" else "connections-closed"

  companion object {
    const val TICK_MS = 1_000L
    const val RELEASE_TIMEOUT_MS = 10_000L
    const val CONNECT_TIMEOUT_MS = 10_000
    const val READ_TIMEOUT_MS = 15_000

    fun tracksOf(tracks: Tracks): List<Track> =
      tracks.groups.flatMapIndexed { groupIndex, group ->
        val type =
          when (group.type) {
            C.TRACK_TYPE_VIDEO -> "video"
            C.TRACK_TYPE_AUDIO -> "audio"
            C.TRACK_TYPE_TEXT -> "text"
            else -> return@flatMapIndexed emptyList()
          }
        (0 until group.length).map { index ->
          val format: Format = group.getTrackFormat(index)
          Track(
            id = "$groupIndex:$index",
            type = type,
            codec = format.sampleMimeType,
            language = format.language?.takeIf { it != C.LANGUAGE_UNDETERMINED },
            label = format.label,
            width = format.width.takeIf { it != Format.NO_VALUE },
            height = format.height.takeIf { it != Format.NO_VALUE },
            bitrate = format.bitrate.takeIf { it != Format.NO_VALUE },
            channels = format.channelCount.takeIf { it != Format.NO_VALUE },
            selected = group.isTrackSelected(index),
            supported = group.isTrackSupported(index),
          )
        }
      }

    /**
     * Whether [admission] may read [uri]: a file only files; a source only http and https, and
     * once its address is https, never http, where a login in the address would travel in the
     * clear (as core's providerFetch holds the app's other requests). Every address a playlist
     * names (variants, segments, keys) is checked as it opens; redirects are held to the same by
     * refusing cross-protocol ones from https (see [prepare]).
     */
    fun allows(admission: Admission, uri: Uri): Boolean {
      val scheme = uri.scheme?.lowercase()
      if (admission.hold is HoldRef.LocalFile) return scheme == "file"
      val secure = Uri.parse(admission.url).scheme.equals("https", ignoreCase = true)
      return scheme == "https" || (scheme == "http" && !secure)
    }

    /** [error] as JS reads it. Media3's messages can quote the address, so none is passed on. */
    fun failureOf(error: PlaybackException): Failure {
      val code = error.errorCodeName
      if (generateSequence(error.cause) { it.cause }.any { it is Hold.Refused }) return Failure("cleartext", code)
      val kind =
        when (error.errorCode) {
          PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED,
          PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT,
          PlaybackException.ERROR_CODE_TIMEOUT -> "network"
          PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS -> "http"
          PlaybackException.ERROR_CODE_IO_CLEARTEXT_NOT_PERMITTED -> "cleartext"
          PlaybackException.ERROR_CODE_IO_FILE_NOT_FOUND,
          PlaybackException.ERROR_CODE_IO_NO_PERMISSION -> "file-missing"
          PlaybackException.ERROR_CODE_PARSING_CONTAINER_MALFORMED,
          PlaybackException.ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED,
          PlaybackException.ERROR_CODE_PARSING_MANIFEST_MALFORMED,
          PlaybackException.ERROR_CODE_PARSING_MANIFEST_UNSUPPORTED,
          PlaybackException.ERROR_CODE_IO_INVALID_HTTP_CONTENT_TYPE -> "format"
          PlaybackException.ERROR_CODE_DECODER_INIT_FAILED,
          PlaybackException.ERROR_CODE_DECODER_QUERY_FAILED,
          PlaybackException.ERROR_CODE_DECODING_FAILED,
          PlaybackException.ERROR_CODE_DECODING_FORMAT_EXCEEDS_CAPABILITIES,
          PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED,
          PlaybackException.ERROR_CODE_AUDIO_TRACK_INIT_FAILED -> "decoder"
          else -> "unexpected"
        }
      val status = generateSequence(error.cause) { it.cause }
        .filterIsInstance<HttpDataSource.InvalidResponseCodeException>()
        .firstOrNull()?.responseCode
      return Failure(kind, code, status)
    }
  }
}
