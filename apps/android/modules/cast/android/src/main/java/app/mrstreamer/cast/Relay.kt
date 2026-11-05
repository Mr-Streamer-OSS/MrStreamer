package app.mrstreamer.cast

import java.net.*
import java.io.*
import java.security.SecureRandom
import java.util.concurrent.*

/** Bounded opaque HTTP capability. Closing is acknowledged only after every owned reader exits. */
internal class Relay(
  address: InetAddress,
  private val source: String,
  private val headers: Map<String, String>,
  playlist: Boolean,
  private val rewrite: (String, String) -> String?,
  private val drained: () -> Unit,
) {
  data class Route(val url: String, val playlist: Boolean)
  val token = ByteArray(24).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }
  private val server = ServerSocket(0, 8, address)
  val address = "http://${address.hostAddress}:${server.localPort}/$token/"
  private val routes = linkedMapOf("0" to Route(source, playlist))
  private val sockets = ConcurrentHashMap.newKeySet<Socket>()
  private val upstreams = ConcurrentHashMap.newKeySet<HttpURLConnection>()
  private val pool = ThreadPoolExecutor(1, 1, 0, TimeUnit.SECONDS, ArrayBlockingQueue(8))
  @Volatile private var active = true
  init {
    if (!playlist) {
      try { qualifyFile() }
      catch (cause: Exception) { server.close(); pool.shutdown(); throw IllegalArgumentException("Range-readable MP4/MOV required") }
    }
    Thread({
      while (active) {
        val socket = try { server.accept() } catch (_: IOException) { break }
        sockets.add(socket)
        try { pool.execute { try { serve(socket) } catch (_: Exception) {} finally { sockets.remove(socket); socket.close() } } }
        catch (_: RejectedExecutionException) { sockets.remove(socket); socket.close() }
      }
    }, "cast-relay").apply { isDaemon = true; start() }
  }
  private fun qualifyFile() {
    val bytes = ByteArray(12)
    if (source.startsWith("file:")) {
      RandomAccessFile(File(URI(source)), "r").use { it.readFully(bytes) }
    } else {
      val connection = open(source, "bytes=0-11")
      try {
        require(connection.responseCode == 206 && connection.getHeaderField("Content-Range")?.startsWith("bytes 0-11/") == true)
        java.io.DataInputStream(connection.inputStream).use { it.readFully(bytes) }
      } finally { connection.disconnect(); upstreams.remove(connection) }
    }
    require(bytes.copyOfRange(4, 8).toString(Charsets.US_ASCII) in listOf("ftyp", "moov", "mdat", "wide"))
  }
  @Synchronized fun route(id: String, url: String, playlist: Boolean) {
    check(active && id.matches(Regex("[0-9]{1,10}")))
    val uri = URI(url)
    require(uri.scheme in listOf("http", "https"))
    require(!source.startsWith("https:") || uri.scheme == "https")
    if (id !in routes && routes.size >= 4096) routes.keys.firstOrNull { it != "0" }?.let { routes.remove(it) }
    routes[id] = Route(url, playlist)
  }
  private fun open(url: String, range: String?): HttpURLConnection {
    var current = URL(url)
    val origin = URL(source)
    repeat(6) {
      check(active)
      require(current.protocol in listOf("http", "https"))
      require(origin.protocol != "https" || current.protocol == "https")
      val connection = current.openConnection() as HttpURLConnection
      upstreams.add(connection)
      connection.instanceFollowRedirects = false
      connection.connectTimeout = 6000
      connection.readTimeout = 6000
      connection.useCaches = false
      // Custom credentials never follow a cross-origin redirect or playlist reference.
      if (current.protocol == origin.protocol && current.host == origin.host && current.port == origin.port)
        headers.forEach { (key, value) -> connection.setRequestProperty(key, value) }
      if (range != null) connection.setRequestProperty("Range", range)
      try {
      val status = connection.responseCode
      if (status in listOf(301, 302, 303, 307, 308)) {
        val next = URL(current, connection.getHeaderField("Location") ?: error("redirect"))
        connection.disconnect(); upstreams.remove(connection); current = next
      } else {
        require(status == 200 || status == 206)
        return connection
      }
      } catch (cause: Exception) {
        connection.disconnect(); upstreams.remove(connection); throw cause
      }
    }
    error("redirect limit")
  }
  fun read(id: String): Pair<String, String>? {
    val route = synchronized(this) { routes[id] } ?: return null
    if (!active || !route.playlist) return null
    val connection = open(route.url, null)
    try {
      val bytes = connection.inputStream.use { input ->
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(16384)
        while (output.size() <= 1_048_576) {
          val count = input.read(buffer, 0, minOf(buffer.size, 1_048_577 - output.size()))
          if (count < 0) break
          output.write(buffer, 0, count)
        }
        output.toByteArray()
      }
      require(bytes.size <= 1_048_576)
      return connection.url.toString() to bytes.toString(Charsets.UTF_8)
    } finally { connection.disconnect(); upstreams.remove(connection) }
  }
  private fun serve(socket: Socket) {
    socket.soTimeout = 6000
    val input = socket.getInputStream()
    // A hard header bound independent of line lengths and client pacing.
    val header = ByteArrayOutputStream()
    while (header.size() < 16384) {
      val byte = input.read(); if (byte < 0) return
      header.write(byte)
      if (byte == 10 && header.size() >= 4 && header.toByteArray().takeLast(4) == listOf<Byte>(13, 10, 13, 10)) break
    }
    require(header.size() < 16384 && active)
    val lines = header.toString("US-ASCII").split("\r\n")
    val request = lines.first().split(" ")
    require(request.size == 3 && request[0] in listOf("GET", "HEAD", "OPTIONS"))
    val path = request[1]
    require(path.startsWith("/$token/") && !path.contains('?'))
    val id = path.removePrefix("/$token/").substringBefore('.')
    require(id.matches(Regex("[0-9]{1,10}")))
    val route = synchronized(this) { routes[id] } ?: return
    val output = socket.getOutputStream()
    fun head(status: String, extras: String = "") {
      output.write(("HTTP/1.1 $status\r\nConnection: close\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, HEAD, OPTIONS\r\nAccess-Control-Allow-Headers: Range\r\nAccess-Control-Expose-Headers: Content-Range, Accept-Ranges, Content-Length\r\n$extras\r\n").toByteArray())
    }
    if (request[0] == "OPTIONS") { head("204 No Content"); return }
    val range = lines.drop(1).firstOrNull { it.startsWith("Range:", true) }?.substringAfter(':')?.trim()
    require(range == null || range.matches(Regex("bytes=[0-9]{1,18}-[0-9]{0,18}")))
    if (route.url.startsWith("file:")) {
      RandomAccessFile(File(URI(route.url)), "r").use { file ->
        val start = range?.removePrefix("bytes=")?.substringBefore('-')?.toLong() ?: 0
        val end = range?.substringAfter('-')?.takeIf { it.isNotEmpty() }?.toLong()?.coerceAtMost(file.length() - 1) ?: (file.length() - 1)
        require(start in 0..end)
        val length = end - start + 1
        val partial = if (range != null) "Content-Range: bytes $start-$end/${file.length()}\r\n" else ""
        head(if (range != null) "206 Partial Content" else "200 OK", "Content-Type: video/mp4\r\nAccept-Ranges: bytes\r\nContent-Length: $length\r\n$partial")
        if (request[0] == "HEAD") return
        file.seek(start)
        val buffer = ByteArray(32768); var left = length
        while (active && left > 0) { val count = file.read(buffer, 0, minOf(buffer.size.toLong(), left).toInt()); if (count < 0) break; output.write(buffer, 0, count); left -= count }
      }
    } else if (route.playlist) {
      val (url, body) = read(id) ?: return
      val safe = rewrite(url, body) ?: return
      val bytes = safe.toByteArray()
      require(bytes.size <= 1_048_576)
      head("200 OK", "Content-Type: application/x-mpegURL\r\nContent-Length: ${bytes.size}\r\n")
      if (request[0] != "HEAD") output.write(bytes)
    } else {
      val connection = open(route.url, range)
      try {
        val extras = listOf("Content-Length", "Content-Range", "Accept-Ranges").mapNotNull { key -> connection.getHeaderField(key)?.takeIf { !it.contains('\r') && !it.contains('\n') }?.let { "$key: $it\r\n" } }.joinToString("")
        head(if (connection.responseCode == 206) "206 Partial Content" else "200 OK", "Content-Type: application/octet-stream\r\n$extras")
        if (request[0] != "HEAD") connection.inputStream.use { stream ->
          val buffer = ByteArray(32768)
          while (active) { val count = stream.read(buffer); if (count < 0) break; output.write(buffer, 0, count) }
        }
      } finally { connection.disconnect(); upstreams.remove(connection) }
    }
  }
  fun revoke() {
    synchronized(this) { active = false; routes.clear() }
    server.close()
    sockets.forEach { runCatching { it.close() } }
    upstreams.forEach { it.disconnect() }
    pool.shutdown()
    check(pool.awaitTermination(8, TimeUnit.SECONDS) && upstreams.isEmpty()) { "Readers did not close" }
    drained()
  }
}
