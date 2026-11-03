package app.mrstreamer.transfers

import java.net.URL
import java.net.ServerSocket
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class TransferHttpTest {
  @Test fun crossOriginRedirectsDropEveryNonProtocolHeader() {
    val from = URL("http", "localhost", 80, "/")
    val headers = mapOf("Authorization" to "private", "Cookie" to "private", "X-Api-Key" to "private", "Range" to "bytes=8-", "If-Range" to "version")
    assertEquals(headers, TransferHttp.redirectHeaders(from, URL("http", "localhost", -1, "/next"), headers))
    for (target in listOf(URL("https", "localhost", -1, "/"), URL("http", "localhost", 81, "/"), URL("http", "other.invalid", -1, "/"))) {
      assertEquals(mapOf("Range" to "bytes=8-", "If-Range" to "version"), TransferHttp.redirectHeaders(from, target, headers))
    }
  }

  @Test fun followsRelativeRedirectAndReturnsFinalRangeResponseButCapsLoops() {
    ServerSocket(0).use { server ->
      server.soTimeout = 1000
      val executor = Executors.newSingleThreadExecutor()
      val responses = java.util.concurrent.atomic.AtomicInteger()
      val serving = executor.submit {
        repeat(9) { request ->
          server.accept().use { socket ->
            responses.incrementAndGet()
            val input = socket.getInputStream().bufferedReader()
            while (!input.readLine().isNullOrEmpty()) { }
            val response = if (request == 1) "206 Partial Content\r\nContent-Range: bytes 8-15/16\r\nETag: version\r\nContent-Length: 0"
              else "302 Found\r\nLocation: /next\r\nContent-Length: 0"
            socket.getOutputStream().write("HTTP/1.1 $response\r\nConnection: close\r\n\r\n".toByteArray())
          }
        }
      }
      try {
        val address = URL("http", "localhost", server.localPort, "/start").toString()
        val final = TransferHttp.open(address)
        try {
          assertEquals(206, final.responseCode)
          assertEquals("bytes 8-15/16", final.getHeaderField("Content-Range"))
          assertEquals("version", final.getHeaderField("ETag"))
        } finally { final.disconnect() }
        assertEquals("http", assertThrows(IllegalStateException::class.java) { TransferHttp.open(address) }.message)
        assertEquals(8, responses.get())
        assertFalse(serving.isDone) // The ninth response remains available if the cap is removed.
      } finally {
        server.close()
        executor.shutdownNow()
        executor.awaitTermination(5, TimeUnit.SECONDS)
      }
    }
  }

  @Test fun notificationQueueCopyHasEnglishAndDutchSingularAndPlural() {
    assertEquals("1 more in the queue", TransferWorker.notificationQueue(1, false))
    assertEquals("3 more in the queue", TransferWorker.notificationQueue(3, false))
    assertEquals("Nog 1 download in de wachtrij", TransferWorker.notificationQueue(1, true))
    assertEquals("Nog 3 downloads in de wachtrij", TransferWorker.notificationQueue(3, true))
  }
}
