package app.mrstreamer.transfers

import java.net.HttpURLConnection
import java.net.URL

/** Ephemeral requests only. Redirect targets and network exception messages never escape this boundary. */
object TransferHttp {
  private val redirects = setOf(301, 302, 303, 307, 308)
  private val publicHeaders = setOf("accept-encoding", "user-agent", "range", "if-range")

  fun open(address: String, headers: Map<String, String> = emptyMap()): HttpURLConnection = try {
    follow(URL(address), headers)
  } catch (cause: Exception) { fail(cause) }

  /** Cross-origin hops retain only transfer protocol headers, never caller credentials. */
  fun redirectHeaders(from: URL, to: URL, headers: Map<String, String>): Map<String, String> =
    if (from.protocol.equals(to.protocol, true) && from.host.equals(to.host, true) &&
        from.portOrDefault() == to.portOrDefault()) headers
    else headers.filterKeys { it.lowercase(java.util.Locale.ROOT) in publicHeaders }

  private fun URL.portOrDefault() = if (port == -1) defaultPort else port

  private fun follow(initial: URL, initialHeaders: Map<String, String>): HttpURLConnection {
    var address = initial
    var headers = initialHeaders
    for (hop in 0..5) {
      check(address.protocol in listOf("http", "https") && address.userInfo == null) { "http" }
      val connection = address.openConnection() as HttpURLConnection
      try {
        connection.connectTimeout = 20000
        connection.readTimeout = 20000
        connection.instanceFollowRedirects = false
        headers.forEach { (name, value) -> connection.setRequestProperty(name, value) }
        if (connection.responseCode !in redirects) return connection
        check(hop < 5) { "http" }
        val target = URL(address, connection.getHeaderField("Location") ?: error("http"))
        headers = redirectHeaders(address, target, headers)
        address = target
      } catch (cause: Exception) {
        connection.disconnect()
        fail(cause)
      }
      connection.disconnect()
    }
    error("http")
  }

  private fun fail(cause: Exception): Nothing {
    val transient = cause is java.io.IOException && cause !is java.net.MalformedURLException && cause !is java.net.ProtocolException
    error(if (transient || cause.message == "network") "network" else "http")
  }
}
