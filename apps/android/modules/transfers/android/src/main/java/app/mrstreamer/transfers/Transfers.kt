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
  @Synchronized
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

  fun isBlocked(source: String): Boolean = synchronized(Ledger.lock) { source in blockedSources }

  fun clearAuthority() = synchronized(Ledger.lock) { blockedSources.clear(); reviews.clear() }

  fun block(context: Context, source: String, blocked: Boolean) = synchronized(Ledger.lock) {
    if (blocked) blockedSources.add(source) else blockedSources.remove(source)
    val ledger = Ledger(context)
    val rows = ledger.read()
    if (blocked) rows.filter { it.getString("sourceId") == source && it.optString("state") == "running" }.forEach {
      it.put("state", "queued")
      Ledger.attempt(it)
    }
    ledger.save(rows)
    kick(context)
  }

  fun kick(context: Context) {
    val work = OneTimeWorkRequestBuilder<TransferWorker>()
      .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, java.util.concurrent.TimeUnit.SECONDS)
      .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()).build()
    WorkManager.getInstance(context).enqueueUniqueWork("downloads", if (WorkManager.getInstance(context).getWorkInfosForUniqueWork("downloads").get()
      .any { it.state == WorkInfo.State.RUNNING }) ExistingWorkPolicy.APPEND_OR_REPLACE else ExistingWorkPolicy.REPLACE, work)
  }

  /** Restore process authority, reconcile orphaned work and schedule its continuation. */
  fun restore(context: Context): String {
    val manager = WorkManager.getInstance(context)
    return synchronized(Ledger.lock) {
      val running = manager.getWorkInfosForUniqueWork("downloads").get()
        .any { it.state == WorkInfo.State.RUNNING }
      clearAuthority()
      val result = snapshot(context, !running)
      kick(context)
      result
    }
  }

  /** Return a playable copy, persisting missing or truncated completions before refusing it. */
  fun path(context: Context, id: String): String = synchronized(Ledger.lock) {
    val ledger = Ledger(context)
    val rows = ledger.read()
    val row = rows.first { it.getString("id") == id }
    val file = ledger.media(id)
    if (row.getString("state") != "complete" || !file.isFile || !file.canRead() || file.length() <= 0 || file.length() != row.getLong("total")) {
      ledger.recover(row)
      ledger.save(rows)
      error("missing")
    }
    file.absolutePath
  }

  fun snapshot(context: Context, reconcile: Boolean): String = synchronized(Ledger.lock) {
    val ledger = Ledger(context)
    val rows = ledger.read()
    if (reconcile) {
      for (row in rows) {
        ledger.recover(row)
      }
      for (row in rows.filter { it.getString("state") == "removing" }) {
        try { ledger.discard(row.getString("id")) }
        catch (_: Exception) { row.put("state", "failed").put("reason", "remove") }
      }
      rows.removeAll { it.getString("state") == "removing" }
      ledger.save(rows)
    } else if (rows.any { it.has("blocked") }) ledger.save(rows)
    val publicRows = rows.map { row -> JSONObject(row.toString()).apply {
      for (field in listOf("binding", "attempt", "etag", "modified", "retries")) remove(field)
      put("blocked", isBlocked(getString("sourceId")))
    } }
    JSONObject().put("rows", org.json.JSONArray(publicRows)).put("free", ledger.root.usableSpace).put("notifications", context.getSystemService(android.app.NotificationManager::class.java).areNotificationsEnabled()).toString()
  }

  private data class Review(val source: String, val binding: String, val rows: Map<String, JSONObject>, val expected: Map<String, String>)
  private val reviews = mutableMapOf<String, Review>()

  /** Freeze native file identities and outcomes, never credentials, for one confirmation. */
  fun review(context: Context, json: String): String = synchronized(Ledger.lock) {
    val requested = org.json.JSONArray(json)
    check(requested.length() > 0)
    val source = requested.getJSONObject(0).getString("sourceId")
    val binding = fingerprint(Credentials.read(context, source) ?: error("credentials"))
    val ledger = Ledger(context)
    val rows = ledger.read()
    rows.filter { it.optString("state") == "complete" }.forEach { ledger.recover(it) }
    ledger.save(rows)
    val entries = (0 until requested.length()).map { requested.getJSONObject(it) }.associateBy { row ->
      check(row.getString("sourceId") == source)
      val key = org.json.JSONArray(row.getString("key"))
      val identity = listOf(source, row.getString("kind"), row.getString("mediaId"), row.getString("container"))
      check(key.length() == identity.size && identity.indices.all { key.getString(it) == identity[it] })
      row.getString("key")
    }
    // Attach the reviewed series order to exact files already on this device, including legacy copies.
    for ((key, request) in entries) {
      val kept = rows.find { it.getString("key") == key } ?: continue
      for (field in listOf("seriesKey", "seriesId", "order")) {
        if (request.has(field)) kept.put(field, request.get(field))
      }
    }
    ledger.save(rows)
    val token = UUID.randomUUID().toString()
    reviews[token] = Review(source, binding, entries, rows.associate { it.getString("key") to it.toString() })
    JSONObject().put("token", token).put("snapshot", JSONObject(snapshot(context, false))).toString()
  }

  fun endReview(token: String) = synchronized(Ledger.lock) { reviews.remove(token); Unit }

  /** Compare the durable row again under the writer lock before every accepted addition. */
  fun admit(context: Context, token: String, key: String, expected: String): String = synchronized(Ledger.lock) { synchronized(Credentials) admission@ {
    val review = reviews[token] ?: return@admission "stopped"
    val secret = Credentials.read(context, review.source)
    if (secret == null || fingerprint(secret) != review.binding) return@admission "login"
    val request = review.rows[key] ?: error("identity")
    val ledger = Ledger(context)
    val rows = ledger.read()
    val row = rows.find { it.getString("key") == key }
    if (row != null && row.optString("state") == "complete") { ledger.recover(row); ledger.save(rows) }
    if (row != null && row.optString("reason") == "missing") {
      val file = ledger.media(row.getString("id"))
      if (file.exists()) {
        if (file.isFile && file.canRead() && file.length() > 0 && file.length() == row.optLong("total"))
          row.put("state", "complete").put("reason", "")
        else row.put("state", "failed").put("reason", "file-changed")
        ledger.save(rows)
      }
    }
    val frozen = review.expected[key]
    if ((row == null) != (frozen == null) || row != null && row.toString() != frozen) return@admission "skipped"
    val status = if (row == null) "none" else if (row.optString("state") == "failed")
      when (row.optString("reason")) { "missing" -> "missing"; "file-changed" -> "changed"; else -> "failed" }
      else "held"
    if (status != expected) return@admission "skipped"
    if (status == "missing" && row != null && ledger.media(row.getString("id")).exists()) return@admission "skipped"
    if (row == null) {
      committed(context, key) { add(context, request.toString()); Unit }
      return@admission "added"
    }
    // A replacement receives a new transfer identity.
    if (status in listOf("missing", "changed")) {
      val oldArtwork = ledger.artwork(row.getString("id"))
      val artwork = try { if (oldArtwork.isFile && oldArtwork.length() <= 2 * 1024 * 1024) oldArtwork.readBytes() else null } catch (_: Exception) { null }
      app.mrstreamer.player.LocalFiles.unused(ledger.media(row.getString("id")).absolutePath) {
        command(context, row.getString("id"), "remove", schedule = false)
      }
      check(Ledger(context).read().none { it.getString("key") == key })
      committed(context, key) { add(context, request.toString()); Unit }
      // Keep optional artwork under the replacement identity, never its deleted file URI.
      if (artwork != null) try {
        val added = ledger.read()
        val replacement = added.single { it.getString("key") == key }
        val file = ledger.artwork(replacement.getString("id"))
        file.writeBytes(artwork)
        replacement.put("artwork", android.net.Uri.fromFile(file).toString())
        ledger.save(added)
      } catch (_: Exception) { /* Optional artwork cannot undo a durable admission. */ }
      return@admission "replaced"
    }
    if (status == "failed") { committed(context, key) { command(context, row.getString("id"), "retry") }; return@admission "retried" }
    "skipped"
  } }

  /** Scheduling follows the durable save. A queued row is still an accepted addition if kick fails. */
  private fun committed(context: Context, key: String, operation: () -> Unit) {
    try { operation() }
    catch (cause: Exception) {
      if (Ledger(context).read().none { it.getString("key") == key && it.optString("state") == "queued" }) throw cause
    }
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
    row.remove("artwork")
    row.put("id", UUID.randomUUID().toString()).put("state", "queued")
      .put("binding", fingerprint(secret)).put("bytes", 0).put("total", 0).put("reason", "")
    Ledger.attempt(row)
    rows.add(row)
    ledger.save(rows)
    kick(context)
    row.getString("id")
  }

  fun command(context: Context, id: String, action: String, schedule: Boolean = true) = synchronized(Ledger.lock) { app.mrstreamer.player.LocalFiles.unused(Ledger(context).media(id).absolutePath) command@ {
    val ledger = Ledger(context)
    val rows = ledger.read()
    val row = rows.find { it.getString("id") == id } ?: return@command
    when (action) {
      "pause" -> {
        if (row.getString("state") !in listOf("queued", "running")) return@command
        row.put("state", "paused"); Ledger.attempt(row) }
      "cancel", "remove" -> {
        if (action == "cancel" && row.getString("state") == "complete") return@command
        row.put("state", "removing"); Ledger.attempt(row) }
      "resume", "retry" -> {
        if (row.getString("state") !in listOf("paused", "failed")) return@command
        val secret = Credentials.read(context, row.getString("sourceId")) ?: error("credentials")
        val binding = fingerprint(secret)
        if (binding != row.getString("binding")) {
          check(!ledger.media(id, true).exists() || ledger.media(id, true).delete())
          row.put("binding", binding).put("bytes", 0).put("reason", "changed")
        }
        if (row.optString("reason") == "missing") row.put("bytes", 0).put("total", 0)
        row.put("state", "queued").put("retries", 0)
        Ledger.attempt(row)
      }
      "up", "down" -> {
        val at = rows.indexOf(row)
        if (row.getString("state") !in listOf("queued", "paused")) return@command
        val candidates = if (action == "up") (at - 1 downTo 0) else (at + 1..rows.lastIndex)
        val next = candidates.firstOrNull { rows[it].getString("state") in listOf("queued", "paused") }
          ?: return@command
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
    if (schedule) kick(context)
  } }
}
