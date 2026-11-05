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
    println("PASS opaque token, file ranges, credential isolation and drained revocation")
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
    val relay = Relay(InetAddress.getLoopbackAddress(), "http://127.0.0.1:${upstream.localPort}/private", mapOf("Authorization" to "Bearer fixture"), true, { _, body -> body }, {})
    try {
      check(relay.read("0")?.second == "#EXTM3U\n")
      worker.join(3000)
      check(seen.size == 2)
      check(seen[0].contains("Authorization: Bearer fixture"))
      check(!seen[1].contains("fixture")) { "Credentials followed cross-origin redirect" }
    } finally { relay.revoke(); upstream.close(); worker.join(3000) }
  }
}
