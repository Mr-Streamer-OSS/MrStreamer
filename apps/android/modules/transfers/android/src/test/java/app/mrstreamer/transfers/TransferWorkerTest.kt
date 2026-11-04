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
    var binding = "test-binding"
    @Implementation @JvmStatic fun fingerprint(secret: String): String = binding
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
    Transfers.clearAuthority()
    ledger.root.deleteRecursively()
    DownloadCredentialShadow.authority = JSONObject().put("kind", "xtream").toString()
    WorkManagerTestInitHelper.initializeTestWorkManager(context,
      Configuration.Builder().setExecutor(executor).build())
  }

  @After fun cleanup() {
    androidx.work.WorkManager.getInstance(context).cancelAllWork().result.get()
    executor.shutdownNow()
    executor.awaitTermination(5, TimeUnit.SECONDS)
    Transfers.clearAuthority()
    ledger.save(emptyList())
    ledger.root.deleteRecursively()
    DownloadCredentialShadow.authority = null
    DownloadBindingShadow.binding = "test-binding"
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

  @Test fun invalidResumeRepliesRestartBeforeValidation() {
    for (reply in listOf("416 Range Not Satisfiable", "206 Partial Content")) {
      val row = row().put("total", 16).put("bytes", 8).put("etag", "old")
      ledger.media(row.getString("id"), true).writeText("oldbytes")
      ledger.save(listOf(row))
      serve(2, { index, headers ->
        if (index == 0) {
          assertEquals("bytes=8-", headers["range"])
          answer(reply, "Content-Length: 0", "")
        } else { assertFalse(headers.containsKey("range")); answer() }
      }) { work() }
      assertEquals("complete", ledger.read().single().getString("state"))
      assertEquals("0123456789abcdef", ledger.media(row.getString("id")).readText())
    }
  }

  @Test fun sniffsDocumentsAndPlaylistsRegardlessOfMime() {
    for (mime in listOf("", "application/octet-stream", "video/mp4")) {
      for ((body, reason) in listOf(
        "\uFEFF  #EXTM3U\nentry" to "playlist", "  <!DOCTYPE html>" to "document",
        "<html>error</html>" to "document", "<?xml version='1.0'?>" to "document",
        " {error:true}" to "document", " [error]" to "document")) {
        val row = row()
        ledger.save(listOf(row))
        val headers = "Content-Length: "+body.toByteArray().size + if (mime.isEmpty()) "" else "\r\nContent-Type: $mime"
        serve(response = { _, _ -> answer(headers = headers, body = body) }) { work() }
        assertEquals(reason, ledger.read().single().getString("reason"))
        assertFalse(ledger.media(row.getString("id"), true).exists())
      }
    }
  }

  @Test fun transientRetriesAreBoundedAndDoNotHoldTheNextRow() {
    val failing = row()
    val next = row()
    ledger.save(listOf(failing, next))
    repeat(5) { pass ->
      serve(if (pass == 0) 2 else 1, { index, _ ->
        if (index == 0) answer("503 Unavailable", "Content-Length: 0", "") else answer()
      }) {
        assertEquals(if (pass < 4) ListenableWorker.Result.retry() else ListenableWorker.Result.success(), work())
      }
      assertEquals("complete", ledger.read().last().getString("state"))
    }
    assertEquals("failed", ledger.read().first().getString("state"))
    assertEquals("continued", ledger.read().first().getString("reason"))
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
      java.io.File(ledger.root, "ledger.json").writeText(org.json.JSONArray(listOf(row)).toString())
      assertEquals(ListenableWorker.Result.success(), work())
      val restored = ledger.read().single()
      assertEquals("complete", restored.getString("state"))
      assertFalse(restored.optBoolean("blocked"))
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
    assertTrue(Transfers.isBlocked("test-source"))
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

  @Test fun snapshotExposesPublicFactsAndLiveHoldsOnly() {
    val row = row().put("etag", "private").put("modified", "private").put("retries", 3)
    ledger.save(listOf(row))
    Transfers.block(context, "test-source", true)
    val shown = JSONObject(Transfers.snapshot(context, false)).getJSONArray("rows").getJSONObject(0)
    for (field in listOf("binding", "attempt", "etag", "modified", "retries")) assertFalse(field, shown.has(field))
    assertEquals(row.getString("title"), shown.getString("title"))
    assertEquals(row.getString("id"), shown.getString("id"))
    assertTrue(shown.getBoolean("blocked"))
    Transfers.block(context, "test-source", false)
    assertFalse(JSONObject(Transfers.snapshot(context, false)).getJSONArray("rows").getJSONObject(0).getBoolean("blocked"))
    assertEquals("test-binding", ledger.read().single().getString("binding"))
  }

  @Test fun duplicateAdmissionRetriesAndCompletedCancelPreserveIdentity() {
    Transfers.block(context, "test-source", true)
    val input = row()
    val id = Transfers.add(context, input.toString())
    assertEquals(id, Transfers.add(context, input.toString()))
    assertEquals(1, ledger.read().size)
    val failed = ledger.read().single().put("state", "failed").put("reason", "missing")
      .put("bytes", 12).put("total", 16).put("retries", 4)
    ledger.save(listOf(failed))
    assertEquals(id, Transfers.add(context, input.toString()))
    val retried = ledger.read().single()
    assertEquals("queued", retried.getString("state"))
    assertEquals(0, retried.getInt("bytes"))
    assertEquals(0, retried.getInt("total"))
    assertEquals(0, retried.getInt("retries"))
    assertNotEquals(failed.getString("attempt"), retried.getString("attempt"))
    ledger.media(id).writeText("saved")
    ledger.save(listOf(retried.put("state", "complete")))
    Transfers.command(context, id, "cancel")
    assertEquals("complete", ledger.read().single().getString("state"))
    assertEquals("saved", ledger.media(id).readText())
  }

  @Test fun changedBindingOnExplicitRetryDiscardsObsoletePartial() {
    val row = row().put("state", "failed").put("bytes", 8).put("retries", 4)
    val id = row.getString("id")
    ledger.media(id, true).writeText("obsolete")
    ledger.save(listOf(row))
    DownloadBindingShadow.binding = "replacement-binding"
    Transfers.block(context, "test-source", true)
    Transfers.command(context, id, "retry")
    val current = ledger.read().single()
    assertEquals("replacement-binding", current.getString("binding"))
    assertEquals(0, current.getInt("bytes"))
    assertEquals(0, current.getInt("retries"))
    assertFalse(ledger.media(id, true).exists())
  }

  @Test fun revokedMalformedAndMismatchedCredentialsNeverPromote() {
    for (secret in listOf(null, "malformed", JSONObject().put("kind", "other").put("server", "")
          .put("username", "fixture").put("password", "fixture").toString(),
        JSONObject().put("kind", "xtream").toString())) {
      val row = row()
      ledger.save(listOf(row))
      DownloadCredentialShadow.authority = secret
      assertEquals(ListenableWorker.Result.success(), work())
      assertEquals("failed", ledger.read().single().getString("state"))
      assertEquals("credentials", ledger.read().single().getString("reason"))
      assertFalse(ledger.media(row.getString("id")).exists())
    }
    val existing = row()
    ledger.save(listOf(existing))
    DownloadCredentialShadow.authority = null
    assertThrows(Exception::class.java) { Transfers.add(context, row().toString()) }
    assertEquals(existing.getString("id"), ledger.read().single().getString("id"))
    DownloadCredentialShadow.authority = JSONObject().put("kind", "xtream")
      .put("server", "").put("username", "fixture").put("password", "fixture").toString()
    DownloadBindingShadow.binding = "changed"
    val row = row()
    ledger.save(listOf(row))
    work()
    assertEquals("credentials", ledger.read().single().getString("reason"))
    assertFalse(ledger.media(row.getString("id")).exists())
  }

  @Test fun failedSaveRetainsQueueAndUnlinkFailureCanBeRetried() {
    val row = row()
    val id = row.getString("id")
    ledger.save(listOf(row))
    // AtomicFile's staging destination cannot be opened as a file.
    val staging = java.io.File(ledger.root, "ledger.json.new")
    staging.mkdirs()
    java.io.File(staging, "child").writeText("keep")
    try {
      assertThrows(Exception::class.java) { Transfers.add(context, row().toString()) }
      assertEquals(listOf(id), ledger.read().map { it.getString("id") })
    } finally { staging.deleteRecursively() }
    row.put("state", "running")
    ledger.save(listOf(row))
    val part = ledger.media(id, true)
    part.mkdirs()
    java.io.File(part, "child").writeText("keep")
    Transfers.command(context, id, "remove")
    assertEquals(1, ledger.read().size)
    assertEquals("failed", ledger.read().single().getString("state"))
    assertEquals("remove", ledger.read().single().getString("reason"))
    part.deleteRecursively()
    Transfers.command(context, id, "remove")
    assertTrue(ledger.read().isEmpty())
    ledger.save(listOf(row.put("state", "removing")))
    ledger.media(id).writeText("saved")
    assertEquals(0, JSONObject(Transfers.snapshot(context, true)).getJSONArray("rows").length())
    assertFalse(ledger.media(id).exists())
    assertTrue(ledger.read().isEmpty())
  }

  @Test fun httpFailuresDistinguishRetryFromPermanentRefusal() {
    for ((status, reason) in listOf("429 Too Many Requests" to "continued", "404 Not Found" to "http",
        "401 Unauthorized" to "credentials", "403 Forbidden" to "credentials")) {
      val row = row()
      ledger.save(listOf(row))
      serve(response = { _, _ -> answer(status, "Content-Length: 0", "") }) {
        assertEquals(if (reason == "continued") ListenableWorker.Result.retry() else ListenableWorker.Result.success(), work())
      }
      val current = ledger.read().single()
      assertEquals(reason, current.getString("reason"))
      assertEquals(if (reason == "continued") "queued" else "failed", current.getString("state"))
      assertFalse(ledger.media(row.getString("id")).exists())
    }
    val row = row()
    ledger.save(listOf(row))
    serve(response = { _, _ -> answer(headers = "Content-Length: 32") }) {
      assertEquals(ListenableWorker.Result.retry(), work())
    }
    assertEquals("queued", ledger.read().single().getString("state"))
    assertFalse(ledger.media(row.getString("id")).exists())
  }

  /** Bounded wait on an observed file/ledger transition, never a fixed delay assertion. */
  private fun observed(condition: () -> Boolean) {
    val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
    while (!condition()) {
      check(System.nanoTime() < deadline) { "Expected transfer transition did not occur" }
      Thread.yield()
    }
  }

  /** The server withholds the tail until the caller has observed an open output file. */
  private fun staged(row: JSONObject, prefix: Int, total: Int, during: () -> Unit) {
    ServerSocket(0).use { server ->
      server.soTimeout = 5000
      DownloadCredentialShadow.authority = JSONObject().put("kind", "xtream")
        .put("server", URL("http", "localhost", server.localPort, "").toString())
        .put("username", "fixture").put("password", "fixture").toString()
      val tail = java.util.concurrent.CountDownLatch(1)
      val threads = Executors.newFixedThreadPool(2)
      val serving = threads.submit {
        server.accept().use { socket ->
          socket.soTimeout = 5000
          val reader = socket.getInputStream().bufferedReader()
          while (!reader.readLine().isNullOrEmpty()) { }
          val output = socket.getOutputStream()
          output.write("HTTP/1.1 200 OK\r\nContent-Length: $total\r\nConnection: close\r\n\r\n".toByteArray())
          output.write(ByteArray(prefix) { 65 })
          output.flush()
          check(tail.await(5, TimeUnit.SECONDS))
          try {
            output.write(ByteArray(total - prefix) { 66 })
            output.flush()
          } catch (_: java.io.IOException) {
            // A refusing worker may close the peer before the entire withheld tail is sent.
          }
        }
      }
      val worker = threads.submit<ListenableWorker.Result> { work() }
      try {
        observed { ledger.media(row.getString("id"), true).length() >= prefix }
        during()
        tail.countDown()
        worker.get(10, TimeUnit.SECONDS)
        serving.get(10, TimeUnit.SECONDS)
      } finally {
        tail.countDown(); server.close(); threads.shutdownNow(); threads.awaitTermination(5, TimeUnit.SECONDS)
      }
    }
  }

  @Test fun chunkFenceStopsBytesAfterDescriptorOpened() {
    for (action in listOf("pause", "cancel", "block")) {
      val row = row()
      val id = row.getString("id")
      ledger.save(listOf(row))
      staged(row, 8192, 16384) {
        if (action == "block") Transfers.block(context, "test-source", true)
        else Transfers.command(context, id, action)
      }
      assertFalse(ledger.media(id).exists())
      if (action == "cancel") assertTrue(ledger.read().isEmpty())
      else {
        assertEquals(8192L, ledger.media(id, true).length())
        assertEquals(if (action == "pause") "paused" else "queued", ledger.read().single().getString("state"))
      }
      Transfers.clearAuthority()
    }
  }

  @Test fun checkpointPersistsProgressAndRevalidatesAuthority() {
    val boundary = 4 * 1024 * 1024
    for (revoke in listOf(false, true)) {
      val row = row()
      val id = row.getString("id")
      ledger.save(listOf(row))
      staged(row, boundary, boundary + 8192) {
        observed { synchronized(Ledger.lock) { ledger.read().single().optLong("bytes") == boundary.toLong() } }
        if (revoke) DownloadCredentialShadow.authority = null
      }
      val current = ledger.read().single()
      assertEquals(if (revoke) "failed" else "complete", current.getString("state"))
      if (revoke) {
        assertEquals("credentials", current.getString("reason"))
        assertFalse(ledger.media(id).exists())
      } else assertEquals((boundary + 8192).toLong(), ledger.media(id).length())
    }
  }


  @Test fun authorityIsRecheckedAtTheFourMiBCheckpointBeforeConsumingTheTail() {
    val boundary = 4 * 1024 * 1024
    val row = row()
    val id = row.getString("id")
    ledger.save(listOf(row))
    val total = boundary + 1024 * 1024
    staged(row, boundary - 8192, total) {
      assertEquals(0L, ledger.read().single().optLong("bytes"))
      DownloadBindingShadow.binding = "revoked"
    }
    assertEquals("credentials", ledger.read().single().getString("reason"))
    assertTrue(ledger.media(id, true).length() >= boundary)
    assertTrue(ledger.media(id, true).length() < total)
    assertFalse(ledger.media(id).exists())
  }

  @Test fun foregroundRefusalRetriesWithoutOpeningNetworkAndIsBounded() {
    val row = row()
    ledger.save(listOf(row))
    repeat(5) { pass ->
      val worker = TestWorkerBuilder<TransferWorker>(context, executor)
        .setForegroundUpdater { _, _, _ ->
          androidx.work.impl.utils.futures.SettableFuture.create<Void>().apply {
            setException(IllegalStateException("foreground refused"))
          }
        }.build()
      assertEquals(if (pass < 4) ListenableWorker.Result.retry() else ListenableWorker.Result.success(), worker.doWork())
      val current = ledger.read().single()
      assertEquals(pass + 1, current.getInt("retries"))
      assertEquals(if (pass < 4) "queued" else "failed", current.getString("state"))
      assertFalse(ledger.media(row.getString("id"), true).exists())
      assertEquals("continued", current.getString("reason"))
    }
  }

}
