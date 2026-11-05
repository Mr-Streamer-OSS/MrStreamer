package app.mrstreamer.cast

import android.app.Activity
import android.app.Application
import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Base64
import androidx.media3.common.util.UnstableApi
import app.mrstreamer.player.PlayerHost
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.Promise
import java.net.*
import java.security.SecureRandom
import java.security.cert.X509Certificate
import java.util.concurrent.*
import javax.net.ssl.*

/** Platform-only transport. No global TLS changes, SDK, provider admission or persisted capability. */
@UnstableApi
class CastModule : Module(), Application.ActivityLifecycleCallbacks {
  private val main = Handler(Looper.getMainLooper())
  private val io = Executors.newCachedThreadPool()
  private val writes = Executors.newSingleThreadExecutor()
  private val channels = ConcurrentHashMap<String, Socket>()
  private val stops = ConcurrentHashMap<String, ByteArray>()
  private val devices = ConcurrentHashMap<String, NsdServiceInfo>()
  private val relays = ConcurrentHashMap<String, Relay>()
  private val answers = ConcurrentHashMap<String, CompletableFuture<String?>>()
  private var browser: NsdManager.DiscoveryListener? = null
  private val resolves = java.util.ArrayDeque<Pair<NsdServiceInfo, Int>>()
  private var resolving = false
  @Suppress("DEPRECATION")
  private fun resolveNext() {
    if (resolving || browser == null || resolves.isEmpty()) return
    val (info, retry) = resolves.removeFirst()
    val mine = browser
    resolving = true
    nsd.resolveService(info, object : NsdManager.ResolveListener {
      override fun onResolveFailed(info: NsdServiceInfo, code: Int) { main.post {
        resolving = false
        if (browser === mine && code == 3 && retry < 2 && resolves.size < 64) resolves.addLast(info to (retry + 1))
        main.postDelayed({ resolveNext() }, if (code == 3) 100L else 0L)
      } }
      override fun onServiceResolved(info: NsdServiceInfo) { main.post {
        resolving = false
        if (browser === mine && privateV4(info.host) && devices.size < 64) { devices[info.serviceName] = info; browseState() }
        resolveNext()
      } }
    })
  }
  private var application: Application? = null
  private val visible = mutableSetOf<Activity>()
  @Volatile private var foreground = true
  @Volatile private var generation = 0
  private val context get() = requireNotNull(appContext.reactContext)
  private val nsd get() = context.getSystemService(Context.NSD_SERVICE) as NsdManager
  private fun browseState(state: String = "searching") {
    sendEvent("onBrowse", mapOf("state" to state, "tvs" to devices.map { (id, info) ->
      mapOf("id" to id, "name" to (info.attributes["fn"]?.toString(Charsets.UTF_8) ?: info.serviceName).take(200), "model" to info.attributes["md"]?.toString(Charsets.UTF_8)?.take(200))
    }))
  }
  @Suppress("DEPRECATION")
  private fun browse() {
    if (browser != null || !foreground) return
    devices.clear()
    val listener = object : NsdManager.DiscoveryListener {
      override fun onDiscoveryStarted(type: String) = browseState()
      override fun onDiscoveryStopped(type: String) {}
      override fun onStartDiscoveryFailed(type: String, code: Int) { stopBrowsing(); browseState("failed") }
      override fun onStopDiscoveryFailed(type: String, code: Int) {}
      override fun onServiceLost(info: NsdServiceInfo) { devices.remove(info.serviceName); browseState() }
      override fun onServiceFound(info: NsdServiceInfo) {
        if (browser !== this || devices.size >= 64) return
        main.post {
          if (browser === this && resolves.size < 64) { resolves.addLast(info to 0); resolveNext() }
        }
      }
    }
    browser = listener
    try { nsd.discoverServices("_googlecast._tcp.", NsdManager.PROTOCOL_DNS_SD, listener) }
    catch (_: SecurityException) { browser = null; browseState("denied") }
    catch (_: Exception) { browser = null; browseState("failed") }
  }
  private fun stopBrowsing() {
    val listener = browser ?: return
    browser = null
    resolves.clear()
    runCatching { nsd.stopServiceDiscovery(listener) }
  }
  private fun closeChannel(id: String) {
    stops.remove(id)
    channels.remove(id)?.let { runCatching { it.close() } }
    sendEvent("onClosed", mapOf("channel" to id))
  }
  private fun cleanup(left: Boolean = true) {
    generation++
    if (left) foreground = false
    if (left) stopBrowsing()
    answers.values.forEach { it.complete(null) }
    answers.clear()
    if (left) PlayerHost.existing()?.stopRemoteOutput()
    channels.entries.toList().forEach { (id, socket) ->
      val stop = stops.remove(id)
      if (stop != null) writes.execute {
        runCatching { socket.getOutputStream().write(stop) }
        closeChannel(id)
      }
      // A blocked write cannot defer revocation or leave the socket alive indefinitely.
      main.postDelayed({ if (channels[id] === socket) closeChannel(id) }, 250)
    }
    relays.entries.toList().forEach { (token, relay) ->
      io.execute { runCatching { relay.revoke(); relays.remove(token, relay) } }
    }
    if (left) sendEvent("onBackground", emptyMap<String, String>())
  }
  override fun definition() = ModuleDefinition {
    Name("Cast")
    Events("onBrowse", "onData", "onClosed", "onPlaylist", "onBackground")
    OnCreate {
      application = context.applicationContext as Application
      application?.registerActivityLifecycleCallbacks(this@CastModule)
      appContext.currentActivity?.let { visible.add(it) }
      foreground = visible.isNotEmpty()
    }
    Function("browse") { main.post { browse() }; Unit }
    Function("stopBrowsing") { main.post { stopBrowsing() }; Unit }
    AsyncFunction("connect") { id: String, device: String, promise: Promise ->
      val epoch = generation
      val info = devices[device]
      if (!foreground || info == null || channels.isNotEmpty()) promise.reject("CAST_CONNECT", "TV unavailable", null)
      else {
        val raw = Socket()
        channels[id] = raw
        io.execute {
          try {
            raw.connect(InetSocketAddress(info.host, info.port), 6000)
            raw.soTimeout = 6000
            // Only this selected LAN socket uses unauthenticated device certificates.
            val trust = object : X509TrustManager {
              override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
              override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) {}
              override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {}
            }
            val ssl = SSLContext.getInstance("TLS").apply { init(null, arrayOf(trust), SecureRandom()) }
              .socketFactory.createSocket(raw, info.host.hostAddress, info.port, true) as SSLSocket
            channels[id] = ssl
            ssl.startHandshake()
            check(foreground && generation == epoch && channels[id] === ssl)
            ssl.soTimeout = 20000
            promise.resolve(null)
            val bytes = ByteArray(16384)
            while (channels[id] === ssl) {
              val count = ssl.inputStream.read(bytes)
              if (count < 0) break
              sendEvent("onData", mapOf("channel" to id, "data" to Base64.encodeToString(bytes, 0, count, Base64.NO_WRAP)))
            }
          } catch (_: Exception) { promise.reject("CAST_CONNECT", "TV connection ended", null) }
          finally { closeChannel(id); runCatching { raw.close() } }
        }
      }
    }
    Function("write") { id: String, data: String ->
      require(data.length <= 90000)
      val socket = channels[id]
      if (socket != null) writes.execute {
        try { socket.getOutputStream().write(Base64.decode(data, Base64.NO_WRAP)) }
        catch (_: Exception) { closeChannel(id) }
      }
    }
    Function("armStop") { id: String, data: String ->
      require(data.length <= 4096)
      if (channels.containsKey(id)) stops[id] = Base64.decode(data, Base64.NO_WRAP)
    }
    Function("disconnect") { id: String -> closeChannel(id) }
    AsyncFunction("serve") { attempt: String, playlist: Boolean, promise: Promise ->
      main.post {
        val owner = PlayerHost.existing()
        val admission = if (foreground) owner?.reserveOutput(attempt) { main.post { cleanup(false) } } else null
        val released = admission?.let { owner?.outputReader(attempt) }
        if (admission == null || released == null) promise.reject("CAST_ADMISSION", "Output unavailable", null)
        else {
          val epoch = generation
          io.execute {
            var made: Relay? = null
            try {
              val peer = channels.values.firstOrNull() ?: error("No selected TV")
              val local = peer.localAddress
              if (!privateV4(local)) throw UnknownHostException("No private route")
              val source = (admission.hold as? app.mrstreamer.player.HoldRef.LocalFile)?.let { java.io.File(it.path).toURI().toString() } ?: admission.url
              var relayToken: String? = null
              val relay = Relay(local, source, admission.headers, playlist, { url, body ->
                val request = java.util.UUID.randomUUID().toString()
                val answer = CompletableFuture<String?>()
                answers[request] = answer
                try {
                  sendEvent("onPlaylist", mapOf("request" to request, "token" to relayToken, "url" to url, "body" to body))
                  answer.get(6, TimeUnit.SECONDS)
                } finally { answers.remove(request) }
              }, { main.post { released() } })
              made = relay
              relayToken = relay.token
              main.post {
                if (!foreground || epoch != generation) {
                  io.execute { runCatching { relay.revoke() } }
                  promise.reject("CAST_RELAY", "App left foreground", null)
                } else {
                  relays[relay.token] = relay
                  promise.resolve(mapOf("address" to relay.address, "token" to relay.token))
                }
              }
            } catch (cause: Exception) {
              if (made == null) main.post { released() }
              else runCatching { made?.revoke() }
              promise.reject(if (cause is UnknownHostException) "CAST_NETWORK" else "CAST_RELAY", "Can't serve this media", null)
            }
          }
        }
      }
    }
    Function("route") { token: String, routes: List<Map<String, Any?>> ->
      require(routes.size <= 4096)
      val relay = relays[token]
      routes.forEach { route -> relay?.route(route["id"] as String, route["url"] as String, route["playlist"] as Boolean, route["pinned"] as? Boolean ?: (route["playlist"] as Boolean)) }
    }
    AsyncFunction("read") { token: String, id: String, promise: Promise ->
      io.execute {
        try { promise.resolve(relays[token]?.read(id)?.let { (url, body) -> mapOf("url" to url, "body" to body) }) }
        catch (_: Exception) { promise.reject("CAST_READ", "Media unreadable", null) }
      }
    }
    Function("answer") { request: String, body: String? ->
      require(body == null || body.length <= 1_048_576)
      answers[request]?.complete(body); Unit
    }
    AsyncFunction("revoke") { token: String, promise: Promise ->
      io.execute {
        try { relays[token]?.let { relay -> relay.revoke(); relays.remove(token, relay) }; promise.resolve(null) }
        catch (_: Exception) { promise.reject("CAST_DRAIN", "Readers did not close", null) }
      }
    }
    OnDestroy {
      main.post { cleanup(); application?.unregisterActivityLifecycleCallbacks(this@CastModule); io.shutdown(); writes.shutdown() }
    }
  }
  override fun onActivityStarted(activity: Activity) { visible.add(activity); foreground = true }
  override fun onActivityStopped(activity: Activity) {
    visible.remove(activity)
    // onPause is still visible in multi-window; configuration recreation is not departure.
    if (visible.isEmpty() && !activity.isChangingConfigurations) cleanup()
  }
  override fun onActivityCreated(activity: Activity, state: Bundle?) {}
  override fun onActivityResumed(activity: Activity) {}
  override fun onActivityPaused(activity: Activity) {}
  override fun onActivitySaveInstanceState(activity: Activity, state: Bundle) {}
  override fun onActivityDestroyed(activity: Activity) { visible.remove(activity) }
  companion object {
    fun privateV4(address: InetAddress?) = address is Inet4Address && address.isSiteLocalAddress && !address.isLoopbackAddress
  }
}
