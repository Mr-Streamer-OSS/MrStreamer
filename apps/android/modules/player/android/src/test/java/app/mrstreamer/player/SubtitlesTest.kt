package app.mrstreamer.player

import java.io.ByteArrayOutputStream
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import org.junit.Assert.*
import org.junit.Test

class SubtitlesTest {
  private fun zip(vararg entries: Pair<String, ByteArray>): ByteArray {
    val output = ByteArrayOutputStream()
    ZipOutputStream(output).use { zip ->
      entries.forEach { (name, bytes) ->
        zip.putNextEntry(ZipEntry(name))
        zip.write(bytes)
        zip.closeEntry()
      }
    }
    return output.toByteArray()
  }

  @Test fun extractsOneSupportedFileWithoutUsingArchivePaths() {
    val text = "WEBVTT\n\n00:00:05.000 --> 00:00:08.000\nHello\n".toByteArray()
    assertArrayEquals(text, Subtitles.unpack(zip("nested/one.vtt" to text, "readme" to "other".toByteArray())))
    assertArrayEquals(text, Subtitles.unpack(text))
  }

  @Test fun refusesAmbiguousAndOversizedArchives() {
    assertThrows(IllegalArgumentException::class.java) {
      Subtitles.unpack(zip("one.srt" to byteArrayOf(1), "two.vtt" to byteArrayOf(2)))
    }
    assertThrows(IllegalArgumentException::class.java) {
      Subtitles.unpack(zip("one.vtt" to ByteArray(Subtitles.LIMIT + 1)))
    }
    assertThrows(IllegalArgumentException::class.java) {
      Subtitles.unpack(zip(*Array(65) { "$it.txt" to byteArrayOf(1) }))
    }
  }

  @Test fun convertsCueClocksAndKeepsText() {
    val text = "WEBVTT\n\n00:00:10.000 --> 00:00:12.000\nHello\n"
    assertEquals("WEBVTT\n\n00:00:09.500 --> 00:00:11.600\nHello\n", Subtitles.timed(text, -1.0, 1.05).toString(Charsets.UTF_8))
    assertArrayEquals(text.toByteArray(), Subtitles.timed(text, 0.0, 1.0))
    assertFalse(Subtitles.timed(text, -20.0, 1.0).toString(Charsets.UTF_8).contains("Hello"))
    assertThrows(IllegalArgumentException::class.java) { Subtitles.timed(text, Double.NaN, 1.0) }
  }
}
