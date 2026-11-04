package app.mrstreamer.transfers

import android.app.*
import android.content.*
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.work.*
import app.mrstreamer.credentials.Credentials
import org.json.JSONObject
import java.net.URLEncoder
import java.io.FileOutputStream

/** One serial queue, independent of the media service. Requests and credentials never enter work data. */
class TransferWorker(private val context: Context, params: WorkerParameters) : Worker(context, params) {
  private val ledger = Ledger(context)

  override fun doWork(): Result {
    var retryPending = false
    val deferred = mutableSetOf<String>()
    while (!isStopped) {
      val row = synchronized(Ledger.lock) {
        val rows = ledger.read()
        rows.firstOrNull { it.getString("id") !in deferred && it.getString("state") in listOf("queued", "running") && !Transfers.isBlocked(it.getString("sourceId")) }?.also {
          ledger.recover(it)
          if (it.getString("state") != "complete") {
            Ledger.attempt(it)
            it.put("state", "running")
          }
          ledger.save(rows)
        }
      } ?: return if (retryPending) Result.retry() else Result.success()
      if (row.getString("state") == "complete") continue
      val id = row.getString("id")
      val attempt = row.getString("attempt")
      try {
        val title = row.getString("title") + if (row.has("season") && row.has("episode"))
          " S${row.getInt("season")} E${row.getInt("episode")}" else ""
        setForegroundAsync(notification(id, title)).get()
      } catch (_: Exception) {
        if (defer(id, attempt)) retryPending = true
        deferred.add(id)
        continue
      }
      try {
        transfer(row, attempt)
      } catch (cause: Exception) {
        val reason = when {
          cause.message in listOf("disk", "credentials", "playlist", "document", "length", "http") -> cause.message!!
          ledger.root.usableSpace < RESERVE -> "disk"
          else -> "continued"
        }
        val transient = cause is java.io.IOException || cause.message in listOf("network", "stopped")
        if (transient) {
          if (defer(id, attempt)) retryPending = true
          deferred.add(id)
        } else update(id, attempt) { it.put("state", "failed").put("reason", reason) }
      }
      if (isStopped) return Result.retry()
    }
    return Result.retry()
  }

  private fun defer(id: String, attempt: String): Boolean {
    var retry = false
    update(id, attempt) {
      val count = it.optInt("retries") + 1
      retry = count < 5
      it.put("retries", count).put("state", if (retry) "queued" else "failed").put("reason", "continued")
    }
    return retry
  }

  private fun update(id: String, attempt: String, change: (JSONObject) -> Unit): Boolean = synchronized(Ledger.lock) {
    val rows = ledger.read()
    val current = rows.find { it.getString("id") == id } ?: return false
    if (current.getString("attempt") != attempt || current.getString("state") !in listOf("queued", "running")) return false
    change(current)
    ledger.save(rows)
    true
  }

  private fun authority(row: JSONObject): JSONObject {
    try {
      val secret = Credentials.read(context, row.getString("sourceId")) ?: error("credentials")
      check(Transfers.fingerprint(secret) == row.getString("binding"))
      return JSONObject(secret).also {
        check(it.getString("kind") == "xtream")
        it.getString("server"); it.getString("username"); it.getString("password")
      }
    } catch (_: Exception) { error("credentials") }
  }

  private fun transfer(row: JSONObject, attempt: String) {
    val id = row.getString("id")
    val auth = authority(row)
    fun encoded(value: String) = URLEncoder.encode(value, "UTF-8").replace("+", "%20")
    val folder = if (row.getString("kind") == "movie") "movie" else "series"
    val address = auth.getString("server").trimEnd('/') + "/$folder/" +
      encoded(auth.getString("username")) + "/" + encoded(auth.getString("password")) + "/" +
      encoded(row.getString("mediaId")) + "." + encoded(row.getString("container"))
    var offset = ledger.media(id, true).length()
    var restarted = false
    while (true) {
      val headers = mutableMapOf("Accept-Encoding" to "identity", "User-Agent" to "MrStreamer-Android/0.1.0")
      if (offset > 0) {
        headers["Range"] = "bytes=$offset-"
        headers["If-Range"] = row.optString("etag").ifEmpty { row.optString("modified") }
      }
      val connection = TransferHttp.open(address, headers)
      try {
        val status = connection.responseCode
        val etag = connection.getHeaderField("ETag") ?: ""
        val modified = connection.getHeaderField("Last-Modified") ?: ""
        val range = connection.getHeaderField("Content-Range")
        val total = if (status == 206) range?.substringAfterLast('/')?.toLongOrNull() ?: -1 else connection.contentLengthLong
        check(status != 401 && status != 403) { "credentials" }
        if (status == 429 || status >= 500) error("network")
        if (offset > 0 && !Ledger.resumes(offset, status, range, etag, modified,
            row.optString("etag"), row.optString("modified"), total, row.optLong("total"))) {
          check(!restarted)
          synchronized(Ledger.lock) {
            if (!update(id, attempt) { it.put("bytes", 0).put("reason", "changed") }) return
            check(!ledger.media(id, true).exists() || ledger.media(id, true).delete())
          }
          offset = 0; restarted = true
          continue
        }
        check(status == 200 || status == 206) { "http" }
        val mime = (connection.contentType ?: "").substringBefore(';').trim().lowercase(java.util.Locale.ROOT)
        check(row.getString("container").lowercase(java.util.Locale.ROOT) !in listOf("m3u", "m3u8", "mpd") &&
          mime !in listOf("application/vnd.apple.mpegurl", "application/x-mpegurl", "audio/mpegurl", "audio/x-mpegurl", "application/dash+xml")) { "playlist" }
        check(!mime.startsWith("text/") && !mime.contains("html") && !mime.contains("json") && !mime.contains("xml")) { "document" }
        check(total > 0) { "length" }
        check(status == 200 || (offset > 0 && status == 206))
        check(total > 0 && total >= offset)
        check(total - offset <= (ledger.root.usableSpace - RESERVE).coerceAtLeast(0)) { "disk" }
        if (!update(id, attempt) { it.put("state", "running").put("total", total).put("etag", etag).put("modified", modified) }) return
        java.io.BufferedInputStream(connection.inputStream).use { input ->
          if (offset == 0L) {
            input.mark(4096)
            val prefix = ByteArray(4096)
            var size = 0
            while (size < prefix.size) {
              val count = input.read(prefix, size, prefix.size - size)
              if (count < 0) break
              size += count
            }
            input.reset()
            val text = String(prefix, 0, size, Charsets.UTF_8).trimStart().removePrefix("\uFEFF").trimStart().lowercase(java.util.Locale.ROOT)
            check(!text.startsWith("#extm3u")) { "playlist" }
            check(listOf("<!doctype", "<html", "<?xml", "{", "[").none { text.startsWith(it) }) { "document" }
          }
          // Open under the unlink lock; stale writers hold only the unlinked file descriptor.
          val stream = synchronized(Ledger.lock) {
            if (!Ledger.current(id, attempt) || Transfers.isBlocked(row.getString("sourceId")) || isStopped) return
            FileOutputStream(ledger.media(id, true), offset > 0)
          }
          stream.use { output ->
            val buffer = ByteArray(256 * 1024)
            var bytes = offset
            var saved = offset
            while (true) {
              if (isStopped) error("stopped")
              val count = input.read(buffer)
              if (count < 0) break
              check(ledger.root.usableSpace >= RESERVE + count) { "disk" }
              check(bytes + count <= total) { "http" }
              synchronized(Ledger.lock) {
                if (isStopped || !Ledger.current(id, attempt) || Transfers.isBlocked(row.getString("sourceId"))) return
                output.write(buffer, 0, count)
              }
              bytes += count
              if (bytes - saved >= 4 * 1024 * 1024) {
                output.fd.sync()
                synchronized(Ledger.lock) {
                  authority(row)
                  val current = ledger.read().firstOrNull { it.getString("id") == id } ?: return
                  if (current.getString("attempt") != attempt) return
                  if (Transfers.isBlocked(row.getString("sourceId"))) {
                    update(id, attempt) { it.put("state", "queued").put("bytes", bytes) }
                    return
                  }
                  if (!update(id, attempt) { it.put("bytes", bytes) }) return
                }
                saved = bytes
              }
            }
            output.fd.sync()
            if (bytes != total) error("network")
          }
        }
        synchronized(Ledger.lock) {
          authority(row)
          update(id, attempt) {
            if (Transfers.isBlocked(row.getString("sourceId"))) {
              it.put("state", "queued").put("bytes", total)
              return@update
            }
            check(ledger.media(id, true).length() == total)
            check(ledger.media(id, true).renameTo(ledger.media(id)))
            check(Ledger.finish(it, attempt, total, total))
          }
        }
        return
      } finally { connection.disconnect() }
    }
  }

  private fun notification(id: String, title: String): ForegroundInfo {
    val manager = context.getSystemService(NotificationManager::class.java)
    manager.createNotificationChannel(NotificationChannel("downloads", "Downloads", NotificationManager.IMPORTANCE_LOW))
    val dutch = context.resources.configuration.locales[0].language == "nl"
    val remaining = synchronized(Ledger.lock) { ledger.read().count { it.getString("state") in listOf("queued", "running") && it.getString("id") != id } }
    val message = if (remaining > 0) {
      notificationQueue(remaining, dutch)
    } else if (dutch) "Downloaden" else "Downloading"
    val builder = Notification.Builder(context, "downloads").setContentTitle(title)
      .setContentText(message).setSmallIcon(android.R.drawable.stat_sys_download).setOngoing(true)
    for ((action, label) in listOf("pause" to if (dutch) "Pauzeren" else "Pause", "cancel" to if (dutch) "Download annuleren" else "Cancel download")) {
      val intent = Intent(context, TransferAction::class.java).setAction(action).putExtra("id", id).putExtra("attempt", synchronized(Ledger.lock) { ledger.read().first { it.getString("id") == id }.getString("attempt") })
      builder.addAction(Notification.Action.Builder(null, label,
        PendingIntent.getBroadcast(context, id.hashCode(), intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)).build())
    }
    return if (Build.VERSION.SDK_INT >= 29) ForegroundInfo(666, builder.build(), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
      else ForegroundInfo(666, builder.build())
  }

  companion object {
    const val RESERVE = 16L * 1024 * 1024
    fun notificationQueue(count: Int, dutch: Boolean): String = when {
      dutch && count == 1 -> "Nog 1 download in de wachtrij"
      dutch -> "Nog $count downloads in de wachtrij"
      count == 1 -> "1 more in the queue"
      else -> "$count more in the queue"
    }
  }
}

class TransferAction : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val id = intent.getStringExtra("id") ?: return
    val action = intent.action ?: return
    if (action !in listOf("pause", "cancel")) return
    val pending = goAsync()
    Thread { try {
      synchronized(Ledger.lock) {
        val row = Ledger(context).read().firstOrNull { it.getString("id") == id }
        if (row != null && row.optString("attempt") == intent.getStringExtra("attempt") && row.optString("state") in listOf("queued", "running")) Transfers.command(context, id, action)
      }
    } finally { pending.finish() } }.start()
  }
}
