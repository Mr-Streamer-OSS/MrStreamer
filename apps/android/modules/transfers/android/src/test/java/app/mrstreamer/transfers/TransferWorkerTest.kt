package app.mrstreamer.transfers

import android.content.Context
import androidx.work.Configuration
import androidx.work.ListenableWorker
import androidx.work.testing.TestWorkerBuilder
import androidx.work.testing.WorkManagerTestInitHelper
import app.mrstreamer.credentials.Credentials
import org.json.JSONObject
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.Assert.*
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import java.net.ServerSocket
import java.net.URL
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** Only the Keystore boundary is replaced; work, ledger, HTTP and files are real. */
@Implements(value = Credentials::class, isInAndroidSdk = false)
class DownloadCredentialShadow {
  companion object {
    var authority: String? = null
    @Implementation @JvmStatic fun read(context: Context, id: String): String? = authority
  }
}

@Implements(value = Transfers::class, isInAndroidSdk = false)
class DownloadBindingShadow {
  companion object {
    @Implementation @JvmStatic fun fingerprint(secret: String): String = "test-binding"
  }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], shadows = [DownloadCredentialShadow::class, DownloadBindingShadow::class],
  instrumentedPackages = ["app.mrstreamer.credentials", "app.mrstreamer.transfers"])
class TransferWorkerTest {
  private val context: Context get() = RuntimeEnvironment.getApplication()
  private val ledger get() = Ledger(context)
  private val executor = Executors.newSingleThreadExecutor()

  @Before fun prepare() {
    ledger.root.deleteRecursively()
    DownloadCredentialShadow.authority = JSONObject().put("kind", "xtream").toString()
    WorkManagerTestInitHelper.initializeTestWorkManager(context,
      Configuration.Builder().setExecutor(executor).build())
  }

  @After fun cleanup() {
    androidx.work.WorkManager.getInstance(context).cancelAllWork().result.get()
    executor.shutdownNow()
    executor.awaitTermination(5, TimeUnit.SECONDS)
    ledger.root.deleteRecursively()
    DownloadCredentialShadow.authority = null
  }

  private fun row() = JSONObject().put("id", UUID.randomUUID().toString()).put("key", UUID.randomUUID().toString())
    .put("sourceId", "test-source").put("sourceLabel", "Test source").put("title", "Test movie")
    .put("kind", "movie").put("mediaId", "1").put("container", "mkv").put("binding", "test-binding")
    .put("state", "queued").put("attempt", "previous").put("bytes", 0).put("total", 0).put("reason", "")

  private fun work(): ListenableWorker.Result = TestWorkerBuilder<TransferWorker>(context, executor).build().doWork()

  private fun serve(count: Int = 1, response: (Int, Map<String, String>) -> String, body: () -> Unit) {
    ServerSocket(0).use { server ->
      server.soTimeout = 2000
      DownloadCredentialShadow.authority = JSONObject().put("kind", "xtream")
        .put("server", URL("http", "localhost", server.localPort, "").toString())
        .put("username", "fixture").put("password", "fixture").toString()
      val serving = Executors.newSingleThreadExecutor()
      val done = serving.submit {
        repeat(count) { index -> server.accept().use { socket ->
          socket.soTimeout = 2000
          val reader = socket.getInputStream().bufferedReader()
          reader.readLine()
          val headers = mutableMapOf<String, String>()
          while (true) {
            val line = reader.readLine() ?: break
            if (line.isEmpty()) break
            headers[line.substringBefore(':').lowercase()] = line.substringAfter(':').trim()
          }
          val answer = response(index, headers)
          socket.getOutputStream().write(answer.toByteArray())
        } }
      }
      try { body(); done.get(5, TimeUnit.SECONDS) }
      finally { server.close(); serving.shutdownNow(); serving.awaitTermination(5, TimeUnit.SECONDS) }
    }
  }

  private fun answer(status: String = "200 OK", headers: String = "Content-Length: 16\r\nETag: one", body: String = "0123456789abcdef") =
    "HTTP/1.1 $status\r\n$headers\r\nConnection: close\r\n\r\n$body"

  @Test fun resumesTheSameRepresentation() {
    val row = row().put("total", 16).put("bytes", 8).put("etag", "one")
    ledger.media(row.getString("id"), true).writeText("01234567")
    ledger.save(listOf(row))
    serve(response = { _, headers ->
      assertEquals("bytes=8-", headers["range"])
      answer("206 Partial Content", "Content-Length: 8\r\nContent-Range: bytes 8-15/16\r\nETag: one", "89abcdef")
    }) { assertEquals(ListenableWorker.Result.success(), work()) }
    assertEquals("complete", ledger.read().single().getString("state"))
    assertEquals("0123456789abcdef", ledger.media(row.getString("id")).readText())
  }

  @Test fun changedValidatorRestartsInsteadOfAppending() {
    val row = row().put("total", 16).put("bytes", 8).put("etag", "old")
    ledger.media(row.getString("id"), true).writeText("oldbytes")
    ledger.save(listOf(row))
    serve(2, { index, headers ->
      if (index == 0) answer("206 Partial Content", "Content-Length: 8\r\nContent-Range: bytes 8-15/16\r\nETag: one", "89abcdef")
      else { assertFalse(headers.containsKey("range")); answer() }
    }) { work() }
    assertEquals("0123456789abcdef", ledger.media(row.getString("id")).readText())
  }

  @Test fun aFencedWriterCannotPromote() {
    val row = row()
    ledger.save(listOf(row))
    serve(response = { _, _ ->
      synchronized(Ledger.lock) {
        val rows = ledger.read()
        rows.single().put("state", "paused")
        Ledger.attempt(rows.single())
        ledger.save(rows)
      }
      answer()
    }) { work() }
    assertEquals("paused", ledger.read().single().getString("state"))
    assertFalse(ledger.media(row.getString("id")).exists())
  }

  @Test fun refusesLowDiskAndPlaylistsAndDocumentsAndUnknownLength() {
    for ((headers, reason) in listOf(
      "Content-Length: ${Long.MAX_VALUE - TransferWorker.RESERVE}" to "disk",
      "Content-Length: 16\r\nContent-Type: application/vnd.apple.mpegurl" to "playlist",
      "Content-Length: 16\r\nContent-Type: text/html" to "document",
      "Content-Type: video/mp4" to "length"
    )) {
      val row = row()
      ledger.save(listOf(row))
      serve(response = { _, _ -> answer(headers = headers) }) { work() }
      assertEquals(reason, ledger.read().single().getString("reason"))
      assertFalse(ledger.media(row.getString("id")).exists())
      assertFalse(ledger.media(row.getString("id"), true).exists())
    }
  }

  @Test fun bothPromotionCrashWindowsFinishWithoutNetwork() {
    for (partial in listOf(false, true)) {
      val row = row().put("state", "running").put("total", 16).put("blocked", true)
      ledger.media(row.getString("id"), partial).writeText("0123456789abcdef")
      ledger.save(listOf(row))
      Transfers.snapshot(context, true)
      assertEquals(ListenableWorker.Result.success(), work())
      val restored = ledger.read().single()
      assertEquals("complete", restored.getString("state"))
      assertFalse(restored.getBoolean("blocked"))
      assertEquals(16, restored.getInt("bytes"))
    }
  }

  @Test fun commandsRespectSourceAdmissionAndWaitingOrder() {
    Transfers.block(context, "test-source", true)
    val first = Transfers.add(context, row().toString())
    val complete = row().put("state", "complete")
    val rows = ledger.read().apply { add(complete) }
    ledger.save(rows)
    val last = Transfers.add(context, row().toString())
    assertTrue(ledger.read().last().getBoolean("blocked"))
    Transfers.command(context, last, "pause")
    assertEquals("paused", ledger.read().last().getString("state"))
    Transfers.command(context, last, "up")
    assertEquals(listOf(last, complete.getString("id"), first), ledger.read().map { it.getString("id") })
    Transfers.command(context, last, "down")
    assertEquals(last, ledger.read().last().getString("id"))
    Transfers.command(context, last, "resume")
    assertEquals("queued", ledger.read().last().getString("state"))
    Transfers.command(context, last, "remove")
    assertFalse(ledger.read().any { it.getString("id") == last })
    Transfers.block(context, "test-source", false)
  }
}
