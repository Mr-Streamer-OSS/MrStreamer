package app.mrstreamer.player

import android.media.MediaCodecInfo
import android.media.MediaCodecList
import android.os.Build
import androidx.media3.common.MimeTypes

/**
 * What this phone can decode, as its codec list declares it: for each format, whether a decoder
 * exists and whether one is hardware. A declared decoder is not proof a stream plays (profiles,
 * levels and the file decide). Track support is a renderer declaration too; only installed
 * picture and sound observations qualify playback.
 */
object Capabilities {
  /** The formats IPTV providers send, by the MIME type Media3 names them with. */
  private val FORMATS =
    listOf(
      MimeTypes.VIDEO_H264,
      MimeTypes.VIDEO_H265,
      MimeTypes.VIDEO_MPEG2,
      MimeTypes.VIDEO_MP4V,
      MimeTypes.VIDEO_VP8,
      MimeTypes.VIDEO_VP9,
      MimeTypes.VIDEO_AV1,
      MimeTypes.AUDIO_AAC,
      MimeTypes.AUDIO_MPEG,
      MimeTypes.AUDIO_MPEG_L2,
      MimeTypes.AUDIO_AC3,
      MimeTypes.AUDIO_E_AC3,
      MimeTypes.AUDIO_DTS,
      MimeTypes.AUDIO_OPUS,
      MimeTypes.AUDIO_FLAC,
    )

  /**
   * Containers Media3's readers in this build recognise (the tests read MPEG-TS, MP4, Matroska,
   * WebM and HLS). What a container holds is decoded only where the phone has a decoder for it,
   * which [decoders] says.
   */
  val CONTAINERS = listOf("hls", "mpegts", "mp4", "matroska", "webm", "flv", "ogg", "avi", "mp3", "adts", "flac", "wav")

  fun decoders(): Map<String, Map<String, Boolean>> {
    val infos = MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos.filter { !it.isEncoder }
    return FORMATS.associateWith { mime ->
      val matching = infos.filter { info -> info.supportedTypes.any { it.equals(mime, ignoreCase = true) } }
      mapOf("decoder" to matching.isNotEmpty(), "hardware" to matching.any(::hardware))
    }
  }

  private fun hardware(info: MediaCodecInfo): Boolean =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) info.isHardwareAccelerated
    else !info.name.startsWith("OMX.google.") && !info.name.startsWith("c2.android.")
}
