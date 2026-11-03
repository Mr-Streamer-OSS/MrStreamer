package app.mrstreamer.transfers

import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.functions.Coroutine
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class TransfersModule : Module() {
  private val context get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("Transfers")
    AsyncFunction("restore") Coroutine { ->
      withContext(Dispatchers.IO) {
        Transfers.restore(context)
      }
    }
    AsyncFunction("snapshot") { Transfers.snapshot(context, false) }
    AsyncFunction("enqueue") { json: String -> Transfers.add(context, json) }
    AsyncFunction("command") { id: String, action: String -> Transfers.command(context, id, action) }
    AsyncFunction("cacheArtwork") Coroutine { id: String, address: String ->
      withContext(Dispatchers.IO) {
        val connection = TransferHttp.open(address)
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
            val file = ledger.artwork(id)
            val atomic = android.util.AtomicFile(file)
            val stream = atomic.startWrite()
            try { stream.write(bytes); atomic.finishWrite(stream) }
            catch (cause: Throwable) { atomic.failWrite(stream); throw cause }
            row.put("artwork", android.net.Uri.fromFile(file).toString())
            ledger.save(rows)
          }
        } catch (_: Exception) { error("artwork") } finally { connection.disconnect() }
      }
    }
    AsyncFunction("filePath") { id: String -> Ledger(context).media(id).absolutePath }
    AsyncFunction("path") { id: String ->
      Transfers.path(context, id)
    }
    AsyncFunction("blockSource") { source: String, blocked: Boolean ->
      Transfers.block(context, source, blocked)
    }
  }
}
