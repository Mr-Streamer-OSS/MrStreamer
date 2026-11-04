package app.mrstreamer.player

import androidx.media3.common.Format
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.util.zip.ZipInputStream

/**
 * Bounded in-memory extraction. Archive names never become filesystem paths. A refusal throws
 * [IllegalArgumentException], which PlayerModule reports as "Can't use this subtitle".
 */
object Subtitles {
  const val LIMIT = 10 * 1024 * 1024
  const val TRACK = "mrstreamer-downloaded-subtitle"
  private val SUPPORTED = Regex("(?i).*\\.(srt|vtt)$")
  private val CUE = Regex("(?m)^(\\d{2}:\\d{2}:\\d{2}\\.\\d{3}) --> (\\d{2}:\\d{2}:\\d{2}\\.\\d{3})$")

  fun unpack(bytes: ByteArray): ByteArray {
    require(bytes.size <= LIMIT)
    if (bytes.size < 2 || bytes[0] != 0x50.toByte() || bytes[1] != 0x4b.toByte()) return bytes
    var picked: ByteArray? = null
    var count = 0
    var total = 0
    ZipInputStream(ByteArrayInputStream(bytes)).use { zip ->
      while (true) {
        val entry = zip.nextEntry ?: break
        require(++count <= 64)
        val name = entry.name.substringAfterLast('/')
        val supported = !entry.isDirectory && !entry.name.startsWith("__MACOSX/") && !name.startsWith("._") && SUPPORTED.matches(name)
        if (supported) require(picked == null)
        val out = ByteArrayOutputStream()
        val buffer = ByteArray(8192)
        while (true) {
          val size = zip.read(buffer)
          if (size < 0) break
          total += size
          require(total <= LIMIT)
          if (supported) out.write(buffer, 0, size)
        }
        if (supported) picked = out.toByteArray()
      }
    }
    return requireNotNull(picked)
  }

  /** Cue clocks are converted natively before Media3 parses the sidecar. */
  fun timed(text: String, offset: Double, speed: Double): ByteArray {
    require(text.length <= LIMIT && offset.isFinite() && offset in -600.0..600.0 && speed.isFinite() && speed in 0.9..1.1)
    fun stamp(value: String): Long {
      val parts = value.split(':')
      return ((parts[0].toDouble() * 3600 + parts[1].toDouble() * 60 + parts[2].toDouble()) * speed * 1000 + offset * 1000).toLong()
    }
    fun clock(ms: Long): String = "%02d:%02d:%02d.%03d".format(java.util.Locale.US, ms / 3600000, ms / 60000 % 60, ms / 1000 % 60, ms % 1000)
    return text.split("\n\n").mapNotNull { block ->
      val lines = block.lines()
      val match = CUE.matchEntire(lines.first()) ?: return@mapNotNull block
      val end = stamp(match.groupValues[2])
      if (end <= 0) return@mapNotNull null
      val start = stamp(match.groupValues[1]).coerceAtLeast(0)
      "${clock(start)} --> ${clock(end.coerceAtLeast(start + 1))}\n${lines.drop(1).joinToString("\n")}"
    }.joinToString("\n\n").toByteArray(Charsets.UTF_8)
  }
}

/** Whether Media3 reports [this] as the downloaded sidecar; merged sources prefix its id. */
internal val Format.isSidecar get() = id?.substringAfterLast(':') == Subtitles.TRACK
