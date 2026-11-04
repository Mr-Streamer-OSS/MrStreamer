package app.mrstreamer.player

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.os.Handler
import android.os.Looper
import androidx.media3.common.util.UnstableApi
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import expo.modules.kotlin.views.ExpoView

/** An [Admission] as JS sends it: src/player/native.ts. */
class AdmissionRecord : Record {
  @Field val attempt: String = ""
  @Field val url: String = ""
  @Field val headers: Map<String, String> = emptyMap()
  @Field val format: String = "progressive"
  @Field val mode: String = "title"
  @Field val startMs: Double = 0.0
  @Field val title: String = ""
  @Field val preview: Boolean = false
  @Field val sourceId: String? = null
  @Field val path: String? = null
}

/** [PlayerHost]'s owner for the app's JS, every call on the main thread: src/player/native.ts. */
@UnstableApi
class PlayerModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  private val events =
    object : PlayerEvents {
      override fun observed(observation: Observation) = sendEvent("onState", mapOf(observation))

      override fun tracks(attempt: String, tracks: List<Track>) =
        sendEvent("onTracks", mapOf("attempt" to attempt, "tracks" to tracks.map(::mapOf)))

      override fun media(attempt: String, pip: Boolean) = sendEvent("onMedia", mapOf("attempt" to attempt, "pip" to pip, "pipSupported" to PlayerPip.supported()))
      override fun mediaCommand(attempt: String, command: String) = sendEvent("onMediaCommand", mapOf("attempt" to attempt, "command" to command))

      override fun released(release: Release) =
        sendEvent(
          "onReleased",
          mapOf("attempt" to release.attempt, "hold" to mapOf(release.hold), "outcome" to release.outcome),
        )
    }

  /** The owner, sending its observations to this module's JS. */
  private fun owner() = PlayerHost.owner(context).also { it.events = events }

  override fun definition() = ModuleDefinition {
    Name("Player")
    Events("onState", "onTracks", "onReleased", "onMedia", "onMediaCommand")

    AsyncFunction("admit") { record: AdmissionRecord ->
      val hold =
        record.path?.let { HoldRef.LocalFile(it) }
          ?: HoldRef.Source(record.sourceId ?: throw IllegalArgumentException("An admission names its source or file"))
      owner().admit(
        Admission(record.attempt, record.url, record.headers, record.format, record.mode, record.startMs.toLong(), hold, record.title, record.preview),
      )
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("pause") { attempt: String -> owner().pause(attempt) }.runOnQueue(Queues.MAIN)
    AsyncFunction("resume") { attempt: String -> owner().resume(attempt) }.runOnQueue(Queues.MAIN)
    AsyncFunction("seek") { attempt: String, positionMs: Double -> owner().seek(attempt, positionMs.toLong()) }
      .runOnQueue(Queues.MAIN)
    AsyncFunction("setSpeed") { attempt: String, speed: Double -> owner().setSpeed(attempt, speed.toFloat()) }
      .runOnQueue(Queues.MAIN)
    AsyncFunction("setQuality") { attempt: String, trackId: String? -> owner().setQuality(attempt, trackId) }
      .runOnQueue(Queues.MAIN)
    AsyncFunction("setAudio") { attempt: String, trackId: String -> owner().setAudio(attempt, trackId) }.runOnQueue(Queues.MAIN)
    AsyncFunction("setSubtitleInset") { fraction: Double -> owner().setSubtitleInset(fraction.toFloat()) }.runOnQueue(Queues.MAIN)
    AsyncFunction("setSubtitleSize") { size: Double -> owner().setSubtitleSize(size.toFloat()) }.runOnQueue(Queues.MAIN)
    AsyncFunction("unpackSubtitle") { bytes: List<Int> ->
      try { Subtitles.unpack(bytes.map { it.toByte() }.toByteArray()).map { it.toInt() and 255 } }
      catch (_: Exception) { throw IllegalArgumentException("Can't use this subtitle") }
    }
    AsyncFunction("setSidecar") { attempt: String, text: String, language: String, offset: Double, speed: Double ->
      owner().setSidecar(attempt, text, language, offset, speed)
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("setText") { attempt: String, trackId: String? -> owner().setText(attempt, trackId) }.runOnQueue(Queues.MAIN)
    AsyncFunction("setNextAvailable") { attempt: String, available: Boolean ->
      val current = owner()
      if (current.attempt == attempt && current.nextAvailable != available) { current.nextAvailable = available; current.changed?.invoke() }
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("setWatch") { enabled: Boolean -> PlayerPip.watch(enabled) }.runOnQueue(Queues.MAIN)
    Function("pipSupported") { PlayerPip.supported() }
    AsyncFunction("enterPip") { PlayerPip.enter() }.runOnQueue(Queues.MAIN)
    AsyncFunction("reconcile") { owner().reconcile(); PlayerPip.reconcile() }.runOnQueue(Queues.MAIN)
    AsyncFunction("stop") { attempt: String -> owner().stop(attempt) }.runOnQueue(Queues.MAIN)
    Function("capabilities") {
      mapOf("containers" to Capabilities.CONTAINERS, "decoders" to Capabilities.decoders())
    }

    // A reload of the app's JS leaves nothing playing that its new JS doesn't know of.
    OnDestroy { Handler(Looper.getMainLooper()).post { PlayerHost.existing()?.stopAll() } }

    View(PlayerSurface::class) {}
  }

  private fun mapOf(observation: Observation) =
    mapOf(
      "attempt" to observation.attempt,
      "phase" to observation.phase.name.lowercase(),
      "positionMs" to observation.positionMs.toDouble(),
      "durationMs" to observation.durationMs?.toDouble(),
      "bufferedMs" to observation.bufferedMs.toDouble(),
      "live" to observation.live,
      "seekable" to observation.seekable,
      "speed" to observation.speed.toDouble(),
      "qualityAutomatic" to (PlayerHost.existing()?.automatic ?: true),
      "failure" to
        observation.failure?.let { mapOf("kind" to it.kind, "code" to it.code, "status" to it.status) },
    )

  private fun mapOf(track: Track) =
    mapOf(
      "id" to track.id,
      "type" to track.type,
      "codec" to track.codec,
      "language" to track.language,
      "label" to track.label,
      "width" to track.width,
      "height" to track.height,
      "bitrate" to track.bitrate,
      "channels" to track.channels,
      "selected" to track.selected,
      "supported" to track.supported,
    )

  private fun mapOf(hold: HoldRef) =
    when (hold) {
      is HoldRef.Source -> mapOf("kind" to "source", "sourceId" to hold.sourceId)
      is HoldRef.LocalFile -> mapOf("kind" to "file", "path" to hold.path)
    }
}

/**
 * Where the one player's picture shows. Several can be mounted (Watch over the mini player); the
 * newest attached shows it, and when it goes the one before takes it back.
 */
@UnstableApi
@SuppressLint("ViewConstructor")
class PlayerSurface(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  // PlayerView sizes its picture to the stream's aspect ratio with Android's own layout.
  override val shouldUseAndroidLayout = true

  private val view =
    PlayerView(context).apply {
      useController = false
      resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FIT
      setShutterBackgroundColor(Color.BLACK)
      setBackgroundColor(Color.BLACK)
      setKeepContentOnPlayerReset(true)
      isFocusable = false
      importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
    }

  init {
    addView(view, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    PlayerHost.owner(context).attach(view)
  }

  override fun onDetachedFromWindow() {
    PlayerHost.owner(context).detach(view)
    super.onDetachedFromWindow()
  }
}
