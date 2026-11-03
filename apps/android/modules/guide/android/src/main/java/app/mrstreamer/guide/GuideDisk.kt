package app.mrstreamer.guide

import android.os.StatFs
import java.io.File
import java.io.InputStream
import java.io.PushbackInputStream
import java.util.zip.GZIPInputStream

class GuideDisk(val root: File) {
  init { if (!root.exists() && !root.mkdirs()) throw GuideFailure("disk") }
  @Synchronized fun check(growth: Long = 0) {
    val used = root.walkTopDown().filter { it.isFile }.sumOf { it.length() }
    if (used + growth > GuideBudget.DISK || StatFs(root.path).availableBytes - growth < GuideBudget.FREE)
      throw GuideFailure("disk")
  }
  fun copy(input: InputStream, target: File, cap: Long, job: GuideJob) {
    val used = root.walkTopDown().filter { it.isFile && it != target }.sumOf { it.length() }
    target.outputStream().use { out ->
      val buffer = ByteArray(32768)
      var count = 0L
      while (true) {
        job.check()
        val n = input.read(buffer)
        if (n < 0) break
        count += n
        if (count > cap) throw GuideFailure("body")
        if (used + count > GuideBudget.DISK || StatFs(root.path).availableBytes - n < GuideBudget.FREE) throw GuideFailure("disk")
        out.write(buffer, 0, n)
      }
      out.fd.sync()
    }
  }
  fun unpack(source: File, target: File, job: GuideJob) {
    job.check()
    source.inputStream().use { raw ->
      val input = PushbackInputStream(raw, 2)
      val a = input.read(); val b = input.read()
      if (b >= 0) input.unread(b)
      if (a >= 0) input.unread(a)
      if (a == 31 && b == 139) {
        try { GZIPInputStream(input).use { copy(it, target, GuideBudget.PLAIN, job) } }
        catch (e: GuideFailure) { throw e }
        catch (_: Exception) { throw GuideFailure("gzip") }
      } else copy(input, target, GuideBudget.PLAIN, job)
    }
  }
}
