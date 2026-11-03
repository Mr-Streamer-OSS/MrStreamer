package app.mrstreamer.transfers

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class TransfersModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("Transfers")
    AsyncFunction("restore") {
      val context = appContext.reactContext ?: error("context")
      androidx.work.WorkManager.getInstance(context).cancelUniqueWork("downloads").result.get()
      val result = Transfers.snapshot(context, true)
      Transfers.kick(context)
      result
    }
    AsyncFunction("snapshot") { Transfers.snapshot(appContext.reactContext ?: error("context"), false) }
    AsyncFunction("enqueue") { json: String -> Transfers.add(appContext.reactContext ?: error("context"), json) }
    AsyncFunction("command") { id: String, action: String -> Transfers.command(appContext.reactContext ?: error("context"), id, action) }
    AsyncFunction("cacheArtwork") { id: String, address: String ->
      val context = appContext.reactContext ?: error("context")
      require(java.net.URL(address).protocol == "https")
      val connection = java.net.URL(address).openConnection() as java.net.HttpURLConnection
      connection.connectTimeout = 15000
      connection.readTimeout = 15000
      connection.instanceFollowRedirects = false
      try {
        check(connection.responseCode == 200)
        val bytes = connection.inputStream.use { input ->
          val buffer = java.io.ByteArrayOutputStream()
          val block = ByteArray(8192)
          while (true) {
            val count = input.read(block)
            if (count < 0) break
            check(buffer.size() + count <= 8 * 1024 * 1024)
            buffer.write(block, 0, count)
          }
          buffer.toByteArray()
        }
        synchronized(Ledger.lock) {
          val ledger = Ledger(context)
          val rows = ledger.read()
          val row = rows.first { it.getString("id") == id }
          val file = java.io.File(ledger.root, "$id.art")
          val atomic = android.util.AtomicFile(file)
          val stream = atomic.startWrite()
          try { stream.write(bytes); atomic.finishWrite(stream) }
          catch (cause: Throwable) { atomic.failWrite(stream); throw cause }
          row.put("artwork", android.net.Uri.fromFile(file).toString())
          ledger.save(rows)
        }
      } finally { connection.disconnect() }
    }
    AsyncFunction("filePath") { id: String -> Ledger(appContext.reactContext ?: error("context")).media(id).absolutePath }
    AsyncFunction("path") { id: String ->
      val context = appContext.reactContext ?: error("context")
      synchronized(Ledger.lock) {
        val ledger = Ledger(context)
        val row = ledger.read().first { it.getString("id") == id }
        val file = ledger.media(id)
        check(row.getString("state") == "complete" && file.canRead() && file.length() > 0 && file.length() == row.getLong("total")) { "missing" }
        file.absolutePath
      }
    }
    AsyncFunction("blockSource") { source: String, blocked: Boolean ->
      val context = appContext.reactContext ?: error("context")
      synchronized(Ledger.lock) {
        val ledger = Ledger(context)
        val rows = ledger.read()
        rows.filter { it.getString("sourceId") == source }.forEach { it.put("blocked", blocked) }
        ledger.save(rows)
      }
      Transfers.kick(context)
    }
  }
}
