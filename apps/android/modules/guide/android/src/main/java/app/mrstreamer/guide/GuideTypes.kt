package app.mrstreamer.guide

import android.os.SystemClock
import okhttp3.Call

// Phone refusals mirror iOS, all below core/guide/limits.ts's desktop ceilings.
object GuideBudget {
  const val BODY = 32L * 1024 * 1024
  const val PLAIN = 64L * 1024 * 1024
  const val DATABASE = 32L * 1024 * 1024
  const val DISK = 256L * 1024 * 1024
  const val FREE = 256L * 1024 * 1024
  const val TOKEN = 65536
  const val ROWS = 250000
  const val CHANNELS = 10000
  const val DEPTH = 16
}
class GuideFailure(val code: String) : Exception(code)
class GuideJob(val lease: String) {
  @Volatile var cancelled = false
  @Volatile var connection: Call? = null
  var deadline = SystemClock.elapsedRealtime() + 180000
  fun cancel() { cancelled = true; connection?.cancel() }
  fun check() {
    if (cancelled) throw GuideFailure("cancelled")
    if (SystemClock.elapsedRealtime() > deadline) throw GuideFailure("time")
  }
}
fun result(work: () -> Map<String, Any?>): Map<String, Any?> = try {
  mapOf("kind" to "ok", "value" to work())
} catch (e: GuideFailure) {
  if (e.code in listOf("changed", "cancelled")) mapOf("kind" to e.code)
  else mapOf("kind" to "failed", "error" to e.code)
} catch (_: Exception) { mapOf("kind" to "failed", "error" to "disk") }
