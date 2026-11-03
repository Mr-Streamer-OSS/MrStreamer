package app.mrstreamer.transfers

import android.content.Context
import android.util.AtomicFile
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileNotFoundException
import java.util.UUID

/** Whole durable queue. Missing is empty; unreadable is an error, never an empty replacement. */
class Ledger(context: Context) {
  val root = File(context.noBackupFilesDir, "transfers").apply { check(isDirectory || mkdirs()) }
  private val file = AtomicFile(File(root, "ledger.json"))

  fun read(): MutableList<JSONObject> = try {
    val array = JSONArray(String(file.readFully(), Charsets.UTF_8))
    MutableList(array.length()) { array.getJSONObject(it) }
  } catch (cause: FileNotFoundException) {
    if (File(root, "ledger.json").exists() || File(root, "ledger.json.bak").exists()) throw cause
    mutableListOf()
  }

  fun save(rows: List<JSONObject>) {
    val stream = file.startWrite()
    try {
      stream.write(JSONArray(rows).toString().toByteArray())
      file.finishWrite(stream)
    } catch (cause: Throwable) { file.failWrite(stream); throw cause }
  }

  fun media(id: String, partial: Boolean = false): File {
    require(id.matches(Regex("[a-f0-9-]{36}")))
    return File(root, id + if (partial) ".part" else ".media")
  }

  fun artwork(id: String) = File(root, "$id.art")

  /** Unlinks a row's partial, finished and artwork files. Save the ledger first to fence its writer. */
  fun discard(id: String) {
    for (file in listOf(media(id, true), media(id), artwork(id))) check(!file.exists() || file.delete())
  }

  companion object {
    // All workers and bridge calls share this lock, including across new Ledger instances.
    val lock = Any()
    fun attempt(row: JSONObject): String = UUID.randomUUID().toString().also { row.put("attempt", it) }

    /** A resumed response must name exactly the same representation and offset. */
    fun resumes(offset: Long, status: Int, range: String?, etag: String, modified: String,
                oldEtag: String, oldModified: String, length: Long, oldLength: Long): Boolean =
      offset > 0 && status == 206 && validRange(range, offset, length) &&
        (!oldEtag.startsWith("W/") && (oldEtag.isNotEmpty() || oldModified.isNotEmpty())) && etag == oldEtag &&
        modified == oldModified && length == oldLength && length > offset

    private fun validRange(range: String?, offset: Long, total: Long): Boolean {
      val parts = Regex("bytes ([0-9]+)-([0-9]+)/([0-9]+)").matchEntire(range ?: "") ?: return false
      return parts.groupValues[1].toLongOrNull() == offset &&
        parts.groupValues[2].toLongOrNull() == total - 1 && parts.groupValues[3].toLongOrNull() == total
    }

    fun finish(row: JSONObject, attempt: String, bytes: Long, total: Long): Boolean {
      if (row.optString("attempt") != attempt || row.optString("state") != "running" || bytes <= 0 || bytes != total) return false
      row.put("state", "complete").put("bytes", total).put("reason", "")
      return true
    }

    fun reconcile(row: JSONObject, length: Long, readable: Boolean) {
      if (row.getString("state") == "complete" &&
        (!readable || length <= 0 || length != row.optLong("total"))) {
        row.put("state", "failed").put("reason", "missing")
      } else if (row.getString("state") in listOf("running", "queued")) {
        row.put("state", "queued").put("reason", "continued")
        attempt(row) // Any late completion belongs to the previous process.
      }
    }
  }
}
