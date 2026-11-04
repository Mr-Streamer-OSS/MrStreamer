package app.mrstreamer.player

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.util.zip.ZipInputStream

/** Bounded in-memory extraction. Archive names never become filesystem paths. */
object Subtitles {
  const val LIMIT = 10 * 1024 * 1024
  const val TRACK = "mrstreamer-downloaded-subtitle"

  fun unpack(bytes: ByteArray): ByteArray {
    require(bytes.size <= LIMIT) { "Can't use this subtitle" }
    if (bytes.size < 2 || bytes[0] != 0x50.toByte() || bytes[1] != 0x4b.toByte()) return bytes
    var picked: ByteArray? = null
    var count = 0
    var total = 0
    ZipInputStream(ByteArrayInputStream(bytes)).use { zip ->
      while (true) {
        val entry = zip.nextEntry ?: break
        require(++count <= 64) { "Can't use this subtitle" }
        val name = entry.name.substringAfterLast('/')
        val supported = !entry.isDirectory && !entry.name.startsWith("__MACOSX/") && !name.startsWith("._") && Regex("(?i).*\\.(srt|vtt)$").matches(name)
        if (supported) require(picked == null) { "Can't use this subtitle" }
        val out = ByteArrayOutputStream()
        val buffer = ByteArray(8192)
        while (true) {
          val size = zip.read(buffer)
          if (size < 0) break
          total += size
          require(total <= LIMIT) { "Can't use this subtitle" }
          if (supported) out.write(buffer, 0, size)
        }
        if (supported) picked = out.toByteArray()
      }
    }
    return requireNotNull(picked) { "Can't use this subtitle" }
  }

  /** Cue clocks are converted natively before Media3 parses the sidecar. */
  fun timed(text: String, offset: Double, speed: Double): ByteArray {
    require(text.length <= LIMIT && offset.isFinite() && offset in -600.0..600.0 && speed.isFinite() && speed in 0.9..1.1)
    fun stamp(value: String): Long {
      val parts = value.split(':')
      return ((parts[0].toDouble() * 3600 + parts[1].toDouble() * 60 + parts[2].toDouble()) * speed * 1000 + offset * 1000).toLong()
    }
    fun clock(ms: Long): String = "%02d:%02d:%02d.%03d".format(java.util.Locale.US, ms / 3600000, ms / 60000 % 60, ms / 1000 % 60, ms % 1000)
    val cue = Regex("(?m)^(\\d{2}:\\d{2}:\\d{2}\\.\\d{3}) --> (\\d{2}:\\d{2}:\\d{2}\\.\\d{3})$")
    return text.split("\n\n").mapNotNull { block ->
      val lines = block.lines()
      val match = cue.matchEntire(lines.first()) ?: return@mapNotNull block
      val end = stamp(match.groupValues[2])
      if (end <= 0) return@mapNotNull null
      val start = stamp(match.groupValues[1]).coerceAtLeast(0)
      "${clock(start)} --> ${clock(end.coerceAtLeast(start + 1))}\n${lines.drop(1).joinToString("\n")}"
    }.joinToString("\n\n").toByteArray(Charsets.UTF_8)
  }
}
