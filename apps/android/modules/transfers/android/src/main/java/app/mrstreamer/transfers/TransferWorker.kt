package app.mrstreamer.transfers

import android.app.*
import android.content.*
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.work.*
import app.mrstreamer.credentials.Credentials
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.io.FileOutputStream

/** One serial queue, independent of the media service. Requests and credentials never enter work data. */
class TransferWorker(private val context: Context, params: WorkerParameters) : Worker(context, params) {
  private val ledger = Ledger(context)

  override fun doWork(): Result {
    while (!isStopped) {
      val row = synchronized(Ledger.lock) {
        val rows = ledger.read()
        rows.firstOrNull { it.getString("state") in listOf("queued", "running") && !it.optBoolean("blocked") }?.also {
          Ledger.attempt(it)
          it.put("state", "running")
          ledger.save(rows)
        }
      } ?: return Result.success()
      val id = row.getString("id")
      val attempt = row.getString("attempt")
      try {
        setForegroundAsync(notification(id, row.getString("title"))).get()
        transfer(row, attempt)
      } catch (cause: Exception) {
        update(id, attempt) { it.put("state", if (isStopped) "queued" else "failed").put("reason", if (isStopped) "continued" else if (cause.message == "disk" || ledger.root.usableSpace < RESERVE) "disk" else if (cause.message == "credentials") "credentials" else "interrupted") }
      }
      if (isStopped) return Result.retry()
    }
    return Result.retry()
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
    val secret = Credentials.read(context, row.getString("sourceId")) ?: error("credentials")
    check(Transfers.fingerprint(secret) == row.getString("binding")) { "credentials" }
    return JSONObject(secret).also { check(it.getString("kind") == "xtream") }
  }

  private fun transfer(row: JSONObject, attempt: String) {
    val id = row.getString("id")
    val auth = authority(row)
    fun encoded(value: String) = URLEncoder.encode(value, "UTF-8").replace("+", "%20")
    val folder = if (row.getString("kind") == "movie") "movie" else "series"
    val address = auth.getString("server").trimEnd('/') + "/$folder/" +
      encoded(auth.getString("username")) + "/" + encoded(auth.getString("password")) + "/" +
      encoded(row.getString("mediaId")) + "." + encoded(row.getString("container"))
    // Cleartext requests are refused rather than silently exposing a login.
    check(URL(address).protocol == "https")
    var offset = ledger.media(id, true).length()
    var restarted = false
    while (true) {
      val connection = URL(address).openConnection() as HttpURLConnection
      connection.connectTimeout = 20000; connection.readTimeout = 20000
      connection.instanceFollowRedirects = false
      connection.setRequestProperty("Accept-Encoding", "identity")
      connection.setRequestProperty("User-Agent", "MrStreamer-Android/0.1.0")
      if (offset > 0) {
        connection.setRequestProperty("Range", "bytes=$offset-")
        connection.setRequestProperty("If-Range", row.optString("etag").ifEmpty { row.optString("modified") })
      }
      try {
        val status = connection.responseCode
        val etag = connection.getHeaderField("ETag") ?: ""
        val modified = connection.getHeaderField("Last-Modified") ?: ""
        val range = connection.getHeaderField("Content-Range")
        val total = if (status == 206) range?.substringAfterLast('/')?.toLongOrNull() ?: -1 else connection.contentLengthLong
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
        check(status == 200 || (offset > 0 && status == 206))
        check(total > 0 && total >= offset)
        check(total - offset + RESERVE <= ledger.root.usableSpace) { "disk" }
        if (!update(id, attempt) { it.put("state", "running").put("total", total).put("etag", etag).put("modified", modified) }) return
        connection.inputStream.use { input ->
          // Each write checks its fence while holding the same lock as cancel and removal.
          val stream = synchronized(Ledger.lock) {
            val current = ledger.read().firstOrNull { it.getString("id") == id } ?: return
            if (current.getString("attempt") != attempt) return
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
              synchronized(Ledger.lock) {
                authority(row)
                val current = ledger.read().firstOrNull { it.getString("id") == id } ?: return
                if (current.getString("attempt") != attempt) return
                if (current.optBoolean("blocked")) {
                  update(id, attempt) { it.put("state", "queued") }
                  return
                }
                check(ledger.root.usableSpace >= RESERVE + count) { "disk" }
                check(bytes + count <= total)
                output.write(buffer, 0, count)
                bytes += count
                if (bytes - saved >= 1024 * 1024) {
                  output.fd.sync()
                  update(id, attempt) { it.put("bytes", bytes) }
                  saved = bytes
                }
              }
            }
            output.fd.sync()
            check(bytes == total)
          }
        }
        synchronized(Ledger.lock) {
          authority(row)
          update(id, attempt) {
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
      if (dutch) "$remaining meer in de wachtrij" else "$remaining more in the queue"
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

  companion object { const val RESERVE = 16L * 1024 * 1024 }
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
