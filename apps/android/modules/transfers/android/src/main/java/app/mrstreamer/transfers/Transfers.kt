package app.mrstreamer.transfers

import android.content.Context
import androidx.work.*
import app.mrstreamer.credentials.Credentials
import org.json.JSONObject
import java.security.MessageDigest
import java.util.UUID

object Transfers {
  fun fingerprint(secret: String) = MessageDigest.getInstance("SHA-256")
    .digest(secret.toByteArray()).joinToString("") { "%02x".format(it) }

  fun kick(context: Context) {
    val work = OneTimeWorkRequestBuilder<TransferWorker>()
      .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()).build()
    WorkManager.getInstance(context).enqueueUniqueWork("downloads", ExistingWorkPolicy.APPEND_OR_REPLACE, work)
  }

  fun snapshot(context: Context, reconcile: Boolean): String = synchronized(Ledger.lock) {
    val ledger = Ledger(context)
    val rows = ledger.read()
    if (reconcile) {
      for (row in rows) {
        val file = ledger.media(row.getString("id"))
        Ledger.reconcile(row, file.length(), file.isFile && file.canRead())
      }
      for (row in rows.filter { it.getString("state") == "removing" }) {
        for (partial in listOf(true, false)) {
          val file = ledger.media(row.getString("id"), partial)
          check(!file.exists() || file.delete())
        }
      }
      rows.removeAll { it.getString("state") == "removing" }
      ledger.save(rows)
    }
    JSONObject().put("rows", org.json.JSONArray(rows)).put("free", ledger.root.usableSpace).put("notifications", context.getSystemService(android.app.NotificationManager::class.java).areNotificationsEnabled()).toString()
  }

  fun add(context: Context, json: String) = synchronized(Ledger.lock) {
    val row = JSONObject(json)
    val ledger = Ledger(context)
    val rows = ledger.read()
    rows.find { it.getString("key") == row.getString("key") }?.let { return@synchronized it.getString("id") }
    val secret = Credentials.read(context, row.getString("sourceId")) ?: error("credentials")
    row.put("id", UUID.randomUUID().toString()).put("state", "queued")
      .put("binding", fingerprint(secret)).put("bytes", 0).put("total", 0).put("reason", "")
    Ledger.attempt(row)
    rows.add(row)
    ledger.save(rows)
    kick(context)
    row.getString("id")
  }

  fun command(context: Context, id: String, action: String) = synchronized(Ledger.lock) {
    val ledger = Ledger(context)
    val rows = ledger.read()
    val row = rows.find { it.getString("id") == id } ?: return@synchronized
    when (action) {
      "pause" -> {
        if (row.getString("state") !in listOf("queued", "running")) return@synchronized
        row.put("state", "paused"); Ledger.attempt(row) }
      "cancel", "remove" -> {
        if (action == "cancel" && row.getString("state") == "complete") return@synchronized
        row.put("state", "removing"); Ledger.attempt(row) }
      "resume", "retry" -> {
        if (row.getString("state") !in listOf("paused", "failed")) return@synchronized
        val secret = Credentials.read(context, row.getString("sourceId")) ?: error("credentials")
        val binding = fingerprint(secret)
        if (binding != row.getString("binding")) {
          check(!ledger.media(id, true).exists() || ledger.media(id, true).delete())
          row.put("binding", binding).put("bytes", 0).put("reason", "changed")
        }
        row.put("state", "queued")
        Ledger.attempt(row)
      }
      "up", "down" -> {
        val at = rows.indexOf(row)
        val next = (at + if (action == "up") -1 else 1).coerceIn(0, rows.lastIndex)
        rows.removeAt(at); rows.add(next, row)
      }
      else -> error("command")
    }
    ledger.save(rows) // Fence the writer before unlinking either file.
    if (action in listOf("cancel", "remove")) {
      for (partial in listOf(true, false)) {
        val file = ledger.media(id, partial)
        check(!file.exists() || file.delete())
      }
      val artwork = java.io.File(ledger.root, "$id.art")
      check(!artwork.exists() || artwork.delete())
      rows.remove(row)
      ledger.save(rows)
    }
    kick(context)
  }
}
