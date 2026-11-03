package app.mrstreamer.transfers

import android.content.Context
import androidx.work.*
import app.mrstreamer.credentials.Credentials
import org.json.JSONObject
import java.security.KeyStore
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import javax.crypto.KeyGenerator
import javax.crypto.Mac
import javax.crypto.SecretKey
import java.util.UUID

object Transfers {
  private val blockedSources = mutableSetOf<String>()

  @JvmStatic
  fun fingerprint(secret: String): String {
    val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    val alias = "transfers-binding"
    val key = (store.getKey(alias, null) as? SecretKey) ?: KeyGenerator.getInstance(
      KeyProperties.KEY_ALGORITHM_HMAC_SHA256, "AndroidKeyStore"
    ).apply {
      init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN).build())
    }.generateKey()
    return Mac.getInstance("HmacSHA256").apply { init(key) }.doFinal(secret.toByteArray())
      .joinToString("") { "%02x".format(it) }
  }

  fun block(context: Context, source: String, blocked: Boolean) = synchronized(Ledger.lock) {
    if (blocked) blockedSources.add(source) else blockedSources.remove(source)
    val ledger = Ledger(context)
    val rows = ledger.read()
    rows.filter { it.getString("sourceId") == source }.forEach { it.put("blocked", blocked) }
    ledger.save(rows)
    kick(context)
  }

  fun kick(context: Context) {
    val work = OneTimeWorkRequestBuilder<TransferWorker>()
      .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, java.util.concurrent.TimeUnit.SECONDS)
      .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()).build()
    WorkManager.getInstance(context).enqueueUniqueWork("downloads", ExistingWorkPolicy.APPEND_OR_REPLACE, work)
  }

  fun snapshot(context: Context, reconcile: Boolean): String = synchronized(Ledger.lock) {
    val ledger = Ledger(context)
    val rows = ledger.read()
    if (reconcile) {
      for (row in rows) {
        ledger.recover(row)
        row.put("blocked", row.getString("sourceId") in blockedSources)
      }
      for (row in rows.filter { it.getString("state") == "removing" }) {
        try { ledger.discard(row.getString("id")) }
        catch (_: Exception) { row.put("state", "failed").put("reason", "remove") }
      }
      rows.removeAll { it.getString("state") == "removing" }
      ledger.save(rows)
    }
    val publicRows = rows.map { row -> JSONObject(row.toString()).apply {
      for (field in listOf("binding", "attempt", "etag", "modified")) remove(field)
    } }
    JSONObject().put("rows", org.json.JSONArray(publicRows)).put("free", ledger.root.usableSpace).put("notifications", context.getSystemService(android.app.NotificationManager::class.java).areNotificationsEnabled()).toString()
  }

  fun add(context: Context, json: String) = synchronized(Ledger.lock) {
    val row = JSONObject(json)
    val ledger = Ledger(context)
    val rows = ledger.read()
    rows.find { it.getString("key") == row.getString("key") }?.let {
      if (it.getString("state") in listOf("failed", "paused")) command(context, it.getString("id"), "retry")
      return@synchronized it.getString("id")
    }
    val secret = Credentials.read(context, row.getString("sourceId")) ?: error("credentials")
    row.put("id", UUID.randomUUID().toString()).put("state", "queued")
      .put("blocked", row.getString("sourceId") in blockedSources)
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
        if (row.optString("reason") == "missing") row.put("bytes", 0).put("total", 0)
        row.put("state", "queued").put("blocked", row.getString("sourceId") in blockedSources)
        Ledger.attempt(row)
      }
      "up", "down" -> {
        val at = rows.indexOf(row)
        if (row.getString("state") !in listOf("queued", "paused")) return@synchronized
        val candidates = if (action == "up") (at - 1 downTo 0) else (at + 1..rows.lastIndex)
        val next = candidates.firstOrNull { rows[it].getString("state") in listOf("queued", "paused") }
          ?: return@synchronized
        val other = rows[next]; rows[next] = row; rows[at] = other
      }
      else -> error("command")
    }
    ledger.save(rows) // Fence the writer before unlinking either file.
    if (action in listOf("cancel", "remove")) {
      try { ledger.discard(id); rows.remove(row) }
      catch (_: Exception) { row.put("state", "failed").put("reason", "remove") }
      ledger.save(rows)
    }
    kick(context)
  }
}
