package app.mrstreamer.cast

import java.net.*
import java.nio.file.Files

/** Runs the production native relay on loopback with an owned file, never an Android device. */
class CastRelayTest {
  @org.junit.Test fun capability() {
    val file = Files.createTempFile("cast-contract", ".mp4").toFile()
    file.writeText("0123ftyp89ab")
    var released = false
    val relay = Relay(InetAddress.getLoopbackAddress(), file.toURI().toString(), emptyMap(), false, { _, _ -> null }, { released = true })
    fun request(path: String, range: String? = null): String {
      val url = URL(path)
      return Socket(url.host, url.port).use { socket ->
        socket.soTimeout = 1500
        socket.getOutputStream().write(("GET ${url.path} HTTP/1.1\r\nHost: test\r\n${range?.let { "Range: $it\r\n" } ?: ""}\r\n").toByteArray())
        socket.getInputStream().readBytes().toString(Charsets.US_ASCII)
      }
    }
    try {
      val response = request(relay.address + "0.mp4", "bytes=2-5")
      check(response.startsWith("HTTP/1.1 206"))
      check(response.endsWith("23ft")) { "Range bytes were not preserved" }
      check(response.contains("Content-Range: bytes 2-5/12"))
      check(!response.contains(file.path))
      check(request(relay.address.replace(relay.token, "invalid") + "0.mp4").isEmpty()) { "Token was not checked" }
      relay.revoke()
      check(released) { "Reader closure was not reported" }
      check(runCatching { request(relay.address + "0.mp4") }.isFailure) { "Revoked capability still accepts connections" }
      println("PASS opaque token, file ranges and drained revocation")
    } finally { runCatching { relay.revoke() }; file.delete() }
  }

  @org.junit.Test fun redirectsKeepCredentialsOnPhone() {
    val upstream = ServerSocket(0, 4, InetAddress.getLoopbackAddress())
    val seen = java.util.concurrent.CopyOnWriteArrayList<String>()
    val worker = Thread {
      repeat(2) { index -> upstream.accept().use { socket ->
        socket.soTimeout = 2000
        val reader = socket.getInputStream().bufferedReader()
        val request = StringBuilder()
        while (true) { val line = reader.readLine() ?: break; if (line.isEmpty()) break; request.append(line).append('\n') }
        seen.add(request.toString())
        val response = if (index == 0) "HTTP/1.1 302 Found\r\nLocation: http://localhost:${upstream.localPort}/playlist\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        else "HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\n#EXTM3U\n"
        socket.getOutputStream().write(response.toByteArray())
      } }
    }.apply { isDaemon = true; start() }
    val relay = Relay(InetAddress.getLoopbackAddress(), "http://127.0.0.1:${upstream.localPort}/private", mapOf("Authorization" to "Bearer fixture", "User-Agent" to "Cast fixture"), true, { _, body -> body }, {})
    try {
      check(relay.read("0")?.second == "#EXTM3U\n")
      worker.join(3000)
      check(seen.size == 2)
      check(seen[0].contains("Authorization: Bearer fixture"))
      check(seen[1].contains("User-Agent: Cast fixture"))
      check(!seen[1].contains("Bearer fixture")) { "Credentials followed cross-origin redirect" }
    } finally { relay.revoke(); upstream.close(); worker.join(3000) }
  }
  @org.junit.Test fun retirementWaitsForReaderCompletion() {
    val arrived = java.util.concurrent.CountDownLatch(1)
    val finish = java.util.concurrent.CountDownLatch(1)
    val drainStarted = java.util.concurrent.CountDownLatch(1)
    val upstream = ServerSocket(0, 2, InetAddress.getLoopbackAddress())
    val worker = Thread {
      upstream.accept().use { socket ->
        val reader = socket.getInputStream().bufferedReader()
        while (!reader.readLine().isNullOrEmpty()) {}
        socket.getOutputStream().write("HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\n#EXTM3U\n".toByteArray())
      }
    }.apply { isDaemon = true; start() }
    val drained = java.util.concurrent.atomic.AtomicBoolean(false)
    val relay = Relay(InetAddress.getLoopbackAddress(), "http://127.0.0.1:${upstream.localPort}/playlist", emptyMap(), true,
      { _, body -> arrived.countDown(); check(finish.await(3, java.util.concurrent.TimeUnit.SECONDS)); body }, { drained.set(true) })
    val request = Thread { runCatching { URL(relay.address + "0.m3u8").readText() } }.apply { start() }
    var retirement: Thread? = null
    try {
      check(arrived.await(3, java.util.concurrent.TimeUnit.SECONDS))
      retirement = Thread { drainStarted.countDown(); relay.revoke() }.apply { start() }
      check(drainStarted.await(3, java.util.concurrent.TimeUnit.SECONDS))
      // Direct preflight cannot enter after retirement, nor may retirement acknowledge this blocked reader.
      val deadline = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(3)
      while (runCatching { relay.route("9", "http://localhost/segment", false) }.isSuccess) { check(System.nanoTime() < deadline); Thread.yield() }
      check(!drained.get())
      check(runCatching { relay.read("0") }.isFailure)
      finish.countDown()
      retirement.join(3000)
      check(!retirement.isAlive && drained.get())
    } finally { finish.countDown(); request.join(3000); retirement?.join(3000); relay.revoke(); upstream.close(); worker.join(3000) }
  }

  @org.junit.Test fun livePlaylistsAndMapsSurviveMediaRollover() {
    val upstream = ServerSocket(0, 2, InetAddress.getLoopbackAddress())
    val worker = Thread {
      repeat(2) { upstream.accept().use { socket ->
        val reader = socket.getInputStream().bufferedReader()
        while (!reader.readLine().isNullOrEmpty()) {}
        socket.getOutputStream().write("HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\n#EXTM3U\n".toByteArray())
      } }
    }.apply { isDaemon = true; start() }
    val url = "http://127.0.0.1:${upstream.localPort}/playlist"
    val relay = Relay(InetAddress.getLoopbackAddress(), url, emptyMap(), true, { _, body -> body }, {})
    try {
      relay.route("1", url, true)
      relay.route("2", url, false, true)
      for (index in 3..66000) relay.route(index.toString(), url, false)
      check(relay.read("1")?.second == "#EXTM3U\n")
      check(URL(relay.address + "2.mp4").readText() == "#EXTM3U\n")
    } finally { relay.revoke(); upstream.close(); worker.join(3000) }
  }

  @org.junit.Test fun directPreflightRetiresBeforeAnotherReadCanEnter() {
    val accepted = java.util.concurrent.CountDownLatch(1)
    val finish = java.util.concurrent.CountDownLatch(1)
    val upstream = ServerSocket(0, 2, InetAddress.getLoopbackAddress())
    val worker = Thread {
      upstream.accept().use { socket ->
        val input = socket.getInputStream().bufferedReader()
        while (!input.readLine().isNullOrEmpty()) {}
        accepted.countDown()
        finish.await(3, java.util.concurrent.TimeUnit.SECONDS)
      }
    }.apply { isDaemon = true; start() }
    val drained = java.util.concurrent.atomic.AtomicBoolean(false)
    val relay = Relay(InetAddress.getLoopbackAddress(), "http://127.0.0.1:${upstream.localPort}/playlist", emptyMap(), true, { _, body -> body }, { drained.set(true) })
    val read = Thread { runCatching { relay.read("0") } }.apply { start() }
    try {
      check(accepted.await(3, java.util.concurrent.TimeUnit.SECONDS))
      relay.revoke()
      read.join(3000)
      check(!read.isAlive && drained.get())
      check(runCatching { relay.read("0") }.isFailure)
    } finally { finish.countDown(); relay.revoke(); upstream.close(); worker.join(3000); read.join(3000) }
  }

  @org.junit.Test fun aNewRangeReplacesADeferredFileResponse() {
    val file = Files.createTempFile("cast-deferred", ".mp4").toFile()
    file.writeText("0123ftyp89ab")
    java.io.RandomAccessFile(file, "rw").use { it.setLength(16 * 1024 * 1024) }
    val relay = Relay(InetAddress.getLoopbackAddress(), file.toURI().toString(), emptyMap(), false, { _, _ -> null }, {})
    val url = URL(relay.address + "0.mp4")
    val deferred = Socket(url.host, url.port)
    try {
      deferred.soTimeout = 3000
      deferred.getOutputStream().write("GET ${url.path} HTTP/1.1\r\nHost: test\r\n\r\n".toByteArray())
      val input = deferred.getInputStream().bufferedReader()
      check(input.readLine().contains("200"))
      while (!input.readLine().isNullOrEmpty()) {}
      val next = URL(relay.address + "0.mp4").openConnection() as HttpURLConnection
      next.readTimeout = 3000
      next.setRequestProperty("Range", "bytes=2-5")
      try { check(next.responseCode == 206); check(next.inputStream.use { it.readBytes().toString(Charsets.US_ASCII) } == "23ft") }
      finally { next.disconnect() }
    } finally { deferred.close(); relay.revoke(); file.delete() }
  }

}
