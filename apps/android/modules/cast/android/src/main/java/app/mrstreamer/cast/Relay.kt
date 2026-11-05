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
  data class Route(val url: String, val playlist: Boolean, val pinned: Boolean = playlist)
  val token = ByteArray(24).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }
  private val server = ServerSocket(0, 8, address)
  val address = "http://${address.hostAddress}:${server.localPort}/$token/"
  private val routes = linkedMapOf("0" to Route(source, playlist))
  private val sockets = ConcurrentHashMap.newKeySet<Socket>()
  private val upstreams = ConcurrentHashMap.newKeySet<HttpURLConnection>()
  private val requests = ConcurrentHashMap<String, Socket>()
  private val responses = ConcurrentHashMap<Socket, HttpURLConnection>()
  private val incoming = ThreadPoolExecutor(2, 2, 0, TimeUnit.SECONDS, ArrayBlockingQueue(8))
  private val pool = ThreadPoolExecutor(1, 1, 0, TimeUnit.SECONDS, ArrayBlockingQueue(8))
  private val retirement = Object()
  private var readers = 0
  private var acknowledged = false
  private fun <T> reading(block: () -> T): T {
    synchronized(retirement) { check(active); readers++ }
    try { return block() }
    finally { synchronized(retirement) { readers--; retirement.notifyAll() } }
  }
  @Volatile private var active = true
  init {
    if (!playlist) {
      try { qualifyFile() }
      catch (cause: Exception) { server.close(); incoming.shutdown(); pool.shutdown(); throw IllegalArgumentException("Range-readable MP4/MOV required") }
    }
    Thread({
      while (active) {
        val socket = try { server.accept() } catch (_: IOException) { break }
        synchronized(retirement) { if (!active) { socket.close(); break }; sockets.add(socket) }
        try { incoming.execute {
          try {
            val parsed = parse(socket)
            // Only a valid capability for the same route may replace a deferred response.
            if (parsed.request[0] == "GET" && parsed.route != null && !parsed.route.playlist) {
              val old = requests.put(parsed.id, socket)
              if (old != null) {
                runCatching { old.close() }
                responses.remove(old)?.disconnect()
              }
            }
            pool.execute {
              try { reading { check(!socket.isClosed); serve(socket, parsed) } }
              catch (_: Exception) {}
              finally { requests.remove(parsed.id, socket); sockets.remove(socket); socket.close() }
            }
          } catch (_: Exception) { requests.entries.removeIf { it.value === socket }; sockets.remove(socket); socket.close() }
        } }
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
  @Synchronized fun route(id: String, url: String, playlist: Boolean, pinned: Boolean = playlist) {
    check(active && id.matches(Regex("[0-9]{1,10}")))
    val uri = URI(url)
    require(uri.scheme in listOf("http", "https"))
    require(!source.startsWith("https:") || uri.scheme == "https")
    if (id !in routes && routes.size >= 65536) {
      val disposable = routes.entries.firstOrNull { it.key != "0" && !it.value.pinned }?.key ?: error("Route limit")
      routes.remove(disposable)
    }
    routes.remove(id)
    routes[id] = Route(url, playlist, pinned)
  }
  private fun open(url: String, range: String?, response: Socket? = null): HttpURLConnection {
    var current = URL(url)
    val origin = URL(source)
    repeat(6) {
      require(current.protocol in listOf("http", "https"))
      require(origin.protocol != "https" || current.protocol == "https")
      val connection = synchronized(retirement) {
        check(active && (response == null || !response.isClosed))
        (current.openConnection() as HttpURLConnection).also {
          upstreams.add(it)
          if (response != null) responses[response] = it
        }
      }
      connection.instanceFollowRedirects = false
      connection.connectTimeout = 6000
      connection.readTimeout = 6000
      connection.useCaches = false
      // Custom credentials never follow a cross-origin redirect or playlist reference.
      headers.forEach { (key, value) ->
        if (key.equals("User-Agent", true) || (current.protocol == origin.protocol && current.host == origin.host && current.port == origin.port))
          connection.setRequestProperty(key, value)
      }
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
  fun read(id: String): Pair<String, String>? = reading { readPlaylist(id) }
  private fun readPlaylist(id: String): Pair<String, String>? {
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
  private data class Parsed(val id: String, val route: Route?, val request: List<String>, val lines: List<String>)
  private fun parse(socket: Socket): Parsed {
    socket.soTimeout = 6000
    val input = socket.getInputStream()
    // A hard header bound independent of line lengths and client pacing.
    val header = ByteArrayOutputStream()
    while (header.size() < 16384) {
      val byte = input.read(); require(byte >= 0)
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
    return Parsed(id, synchronized(this) { routes[id] }, request, lines)
  }
  private fun serve(socket: Socket, parsed: Parsed) {
    val (id, route, request, lines) = parsed
    val output = socket.getOutputStream()
    fun head(status: String, extras: String = "") {
      output.write(("HTTP/1.1 $status\r\nConnection: close\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, HEAD, OPTIONS\r\nAccess-Control-Allow-Headers: Range\r\nAccess-Control-Expose-Headers: Content-Range, Accept-Ranges, Content-Length\r\n$extras\r\n").toByteArray())
    }
    if (route == null) { head("404 Not Found"); return }
    if (request[0] == "OPTIONS") { head("204 No Content"); return }
    val range = lines.drop(1).firstOrNull { it.startsWith("Range:", true) }?.substringAfter(':')?.trim()
    require(range == null || range.matches(Regex("bytes=[0-9]{1,18}-[0-9]{0,18}")))
    if (route.url.startsWith("file:")) {
      RandomAccessFile(File(URI(route.url)), "r").use { file ->
        val start = range?.removePrefix("bytes=")?.substringBefore('-')?.toLong() ?: 0
        val end = range?.substringAfter('-')?.takeIf { it.isNotEmpty() }?.toLong()?.coerceAtMost(file.length() - 1) ?: (file.length() - 1)
        if (start !in 0..end) { head("416 Range Not Satisfiable", "Content-Range: bytes */${file.length()}\r\n"); return }
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
      val connection = open(route.url, range, socket)
      try {
        val extras = listOf("Content-Length", "Content-Range", "Accept-Ranges").mapNotNull { key -> connection.getHeaderField(key)?.takeIf { !it.contains('\r') && !it.contains('\n') }?.let { "$key: $it\r\n" } }.joinToString("")
        head(if (connection.responseCode == 206) "206 Partial Content" else "200 OK", "Content-Type: application/octet-stream\r\n$extras")
        if (request[0] != "HEAD") connection.inputStream.use { stream ->
          val buffer = ByteArray(32768)
          while (active) { val count = stream.read(buffer); if (count < 0) break; output.write(buffer, 0, count) }
        }
      } finally { responses.remove(socket, connection); connection.disconnect(); upstreams.remove(connection) }
    }
  }
  fun revoke() {
    synchronized(retirement) { active = false }
    synchronized(this) { routes.clear() }
    server.close()
    sockets.forEach { runCatching { it.close() } }
    upstreams.forEach { it.disconnect() }
    incoming.shutdown()
    pool.shutdown()
    val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(8)
    synchronized(retirement) {
      while (readers > 0) {
        val remaining = deadline - System.nanoTime()
        check(remaining > 0) { "Readers did not close" }
        TimeUnit.NANOSECONDS.timedWait(retirement, remaining)
      }
      if (!acknowledged) { acknowledged = true; drained() }
    }
  }
}
