import Darwin
import Foundation
import Security

/// The HTTP server a TV reads media from: a socket on the phone's private Wi-Fi IPv4 address,
/// listening only while a token is served. Each load is served under a token of 128 random bits,
/// with routes JavaScript names; anything else answers 404. GET and HEAD, OPTIONS answered 204,
/// and CORS for the TV's web player. One request per connection.
///
/// The relay is the only reader of the provider while a TV plays: it reads each route with the
/// load's headers, follows redirects itself so none reaches the TV, and passes byte ranges on.
/// Playlists are read whole and rewritten by JavaScript (`onPlaylist`) before the TV gets them,
/// so no provider address reaches it; a playlist JavaScript refuses answers 404. A copy on the
/// phone (`file:`) is served from its file. Revoking a token cancels its upstream requests and
/// cuts its connections, and says when they all ended.
///
/// A BSD socket rather than NWListener, as `title-formats`' loopback server found in the iOS 27
/// simulator; accepting connections needs no permission.
final class CastRelay {
  static let shared = CastRelay()

  /// Asks JavaScript to rewrite a playlist read at `url`; it answers with `answer`.
  var ask: ((_ request: String, _ token: String, _ url: String, _ body: String) -> Void)?

  private struct Route {
    let url: URL
    let playlist: Bool
  }

  /// One served token: its routes, and what still reads under it.
  private final class Served {
    let headers: [String: String]
    var routes: [String: Route]
    var order: [String] = []
    var clients = Set<Int32>()
    var tasks: [Int: URLSessionTask] = [:]
    var active = 0
    var revoked = false
    var waiters: [() -> Void] = []

    init(headers: [String: String], entry: Route) {
      self.headers = headers
      routes = ["0": entry]
    }
  }

  /// The most segment routes a token keeps: a channel's playlists name new segments on every
  /// read. Enough for a film's every segment in two renditions, at the format core's most.
  private static let routesKept = 100_000
  /// The most a playlist may be.
  private static let playlistLimit = 4 * 1024 * 1024
  /// How long JavaScript gets to rewrite a playlist.
  private static let answerWait: DispatchTimeInterval = .seconds(10)

  private let lock = NSLock()
  private var listening: Int32 = -1
  private var address = ""
  private var port: UInt16 = 0
  private var source: DispatchSourceRead?
  private var tokens: [String: Served] = [:]
  /// Connections whose request head hasn't arrived yet, cut when the listener stops.
  private var waiting = Set<Int32>()
  /// Playlists waiting for JavaScript's rewriting, with the token each is read under.
  private var answers: [String: (token: String, answer: (String?) -> Void)] = [:]
  private var requests = 0
  private var taskIds = 0

  /// Starts serving `url` under a new token; nil when the phone has no private Wi-Fi address.
  func serve(_ url: URL, headers: [String: String], playlist: Bool) -> (
    address: String, token: String
  )? {
    lock.lock()
    defer { lock.unlock() }
    guard let token = Self.token(), let host = Self.wifiAddress(), start(on: host) else {
      return nil
    }
    tokens[token] = Served(headers: headers, entry: Route(url: url, playlist: playlist))
    return ("http://\(address):\(port)/\(token)/", token)
  }

  func add(_ routes: [RelayRoute], to token: String) {
    lock.lock()
    defer { lock.unlock() }
    guard let served = tokens[token] else { return }
    // Only the entry route may be a copy's file; what a playlist names is http or https.
    for route in routes {
      guard let url = URL(string: route.url),
        ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
        served.routes[route.id] == nil
      else { continue }
      served.routes[route.id] = Route(url: url, playlist: route.playlist)
      // Playlists stay: the TV reads a channel's again and again. Only old segments go.
      if !route.playlist { served.order.append(route.id) }
    }
    while served.order.count > Self.routesKept {
      served.routes[served.order.removeFirst()] = nil
    }
  }

  /// Reads playlist route `id` of `token` as the TV would, after redirects.
  func read(_ token: String, _ id: String, _ done: @escaping ((url: String, body: String)?) -> Void) {
    DispatchQueue.global().async {
      guard let found = self.enter(token, id) else { return done(nil) }
      defer { self.leave(token, found.served) }
      done(found.route.playlist ? self.fetchPlaylist(found.route.url, found.served) : nil)
    }
  }

  func answer(_ request: String, _ body: String?) {
    lock.lock()
    let waiting = answers.removeValue(forKey: request)
    lock.unlock()
    waiting?.answer(body)
  }

  /// Ends `token`; `done` once every request under it ended. A token stays in the ledger,
  /// refusing new requests, until its readers drained, so revoking it again, as JavaScript does
  /// after the native side cut everything, waits for the same readers.
  func revoke(_ token: String, _ done: @escaping () -> Void) {
    lock.lock()
    guard let served = tokens[token] else {
      lock.unlock()
      return done()
    }
    if served.revoked {
      served.waiters.append(done)
      lock.unlock()
      return
    }
    served.revoked = true
    let unanswered = answers.filter { $0.value.token == token }
    for request in unanswered.keys { answers[request] = nil }
    for task in served.tasks.values { task.cancel() }
    for client in served.clients { shutdown(client, SHUT_RDWR) }
    served.waiters.append(done)
    let finished = drained(token, served)
    lock.unlock()
    for waiting in unanswered.values { waiting.answer(nil) }
    for waiter in finished { waiter() }
  }

  /// A revoked token with no reader left leaves the ledger, and the listener stops once none is
  /// left; answers its waiters to tell. Called with the lock held.
  private func drained(_ token: String, _ served: Served) -> [() -> Void] {
    guard served.revoked, served.active == 0 else { return [] }
    tokens[token] = nil
    if tokens.isEmpty { stopListening() }
    let waiting = served.waiters
    served.waiters = []
    return waiting
  }

  func revokeAll() {
    lock.lock()
    let all = tokens.filter { !$0.value.revoked }.map(\.key)
    lock.unlock()
    for token in all { revoke(token) {} }
  }

  // MARK: Listening

  /// Listens on `host`, keeping a listener on another address while tokens still use it.
  private func start(on host: String) -> Bool {
    if listening >= 0, address == host || !tokens.isEmpty { return true }
    if listening >= 0 { stopListening() }
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    guard fd >= 0 else { return false }
    var on: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &on, socklen_t(MemoryLayout<Int32>.size))
    var bound = sockaddr_in()
    bound.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    bound.sin_family = sa_family_t(AF_INET)
    bound.sin_port = 0
    bound.sin_addr.s_addr = inet_addr(host)
    let bindResult = withUnsafePointer(to: &bound) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
      }
    }
    var named = sockaddr_in()
    var length = socklen_t(MemoryLayout<sockaddr_in>.size)
    let found = withUnsafeMutablePointer(to: &named) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &length) }
    }
    guard bindResult == 0, listen(fd, 16) == 0, found == 0 else {
      close(fd)
      return false
    }
    _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
    let accepting = DispatchSource.makeReadSource(
      fileDescriptor: fd, queue: DispatchQueue(label: "app.mrstreamer.cast.accept"))
    accepting.setEventHandler { [weak self] in self?.accept(fd) }
    accepting.setCancelHandler { close(fd) }
    accepting.resume()
    listening = fd
    address = host
    port = UInt16(bigEndian: named.sin_port)
    source = accepting
    return true
  }

  private func stopListening() {
    source?.cancel()
    source = nil
    listening = -1
    for client in waiting { shutdown(client, SHUT_RDWR) }
  }

  private func accept(_ fd: Int32) {
    while true {
      let client = Darwin.accept(fd, nil, nil)
      if client < 0 { return }
      var on: Int32 = 1
      setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
      _ = fcntl(client, F_SETFL, fcntl(client, F_GETFL) & ~O_NONBLOCK)
      lock.lock()
      waiting.insert(client)
      lock.unlock()
      DispatchQueue(label: "app.mrstreamer.cast.connection").async { [weak self] in
        self?.handle(client)
        close(client)
      }
    }
  }

  // MARK: Requests

  /// Registers a reader of route `id` under `token`; nil when either is gone.
  private func enter(_ token: String, _ id: String, client: Int32? = nil) -> (
    served: Served, route: Route
  )? {
    lock.lock()
    defer { lock.unlock() }
    guard let served = tokens[token], !served.revoked, let route = served.routes[id] else {
      return nil
    }
    served.active += 1
    if let client { served.clients.insert(client) }
    return (served, route)
  }

  private func leave(_ token: String, _ served: Served, client: Int32? = nil) {
    lock.lock()
    served.active -= 1
    if let client { served.clients.remove(client) }
    let finished = drained(token, served)
    lock.unlock()
    for waiter in finished { waiter() }
  }

  /// The most a request's head may take, however slowly it trickles in.
  private static let headDeadline: TimeInterval = 10

  private func handle(_ client: Int32) {
    var pending = Data()
    var chunk = [UInt8](repeating: 0, count: 8 * 1024)
    let deadline = Date().addingTimeInterval(Self.headDeadline)
    defer {
      lock.lock()
      waiting.remove(client)
      lock.unlock()
    }
    while pending.range(of: Data("\r\n\r\n".utf8)) == nil {
      // Each read waits only for what is left of the deadline.
      let left = deadline.timeIntervalSinceNow
      if left <= 0 || pending.count > 32 * 1024 { return }
      var patience = timeval(tv_sec: Int(left), tv_usec: Int32((left - floor(left)) * 1_000_000))
      setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &patience, socklen_t(MemoryLayout<timeval>.size))
      let read = chunk.withUnsafeMutableBytes { recv(client, $0.baseAddress, $0.count, 0) }
      if read <= 0 { return }
      pending.append(contentsOf: chunk[0..<read])
    }
    lock.lock()
    waiting.remove(client)
    lock.unlock()
    // Streaming to the TV can take long: the deadline was for the head only.
    var unlimited = timeval(tv_sec: 0, tv_usec: 0)
    setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &unlimited, socklen_t(MemoryLayout<timeval>.size))
    let head = String(decoding: pending, as: UTF8.self).components(separatedBy: "\r\n\r\n")[0]
    let lines = head.components(separatedBy: "\r\n")
    let parts = lines.first?.split(separator: " ") ?? []
    let method = parts.first.map(String.init) ?? ""
    let path = parts.count > 1 ? (parts[1].split(separator: "?").first.map(String.init) ?? "") : ""
    var range: String?
    for line in lines.dropFirst() where line.lowercased().hasPrefix("range:") {
      range = line.dropFirst(6).trimmingCharacters(in: .whitespaces)
    }
    if method == "OPTIONS" { return reply(client, status: 204, headers: [:], body: nil) }
    let segments = path.split(separator: "/").map(String.init)
    guard method == "GET" || method == "HEAD", segments.count == 2 else {
      return reply(client, status: 404, headers: [:], body: Data())
    }
    let id = segments[1].split(separator: ".").first.map(String.init) ?? ""
    guard let found = enter(segments[0], id, client: client) else {
      return reply(client, status: 404, headers: [:], body: Data())
    }
    let (served, route) = (found.served, found.route)
    defer { leave(segments[0], served, client: client) }
    if route.playlist {
      playlist(client, token: segments[0], route: route, served: served, head: method == "HEAD")
    } else if route.url.isFileURL {
      file(client, route.url, range: range, head: method == "HEAD")
    } else {
      relay(client, route.url, served: served, range: range, method: method)
    }
  }

  private func playlist(_ client: Int32, token: String, route: Route, served: Served, head: Bool) {
    guard let read = fetchPlaylist(route.url, served), let rewritten = rewrite(token, read) else {
      return reply(client, status: 404, headers: [:], body: Data())
    }
    let body = Data(rewritten.utf8)
    reply(
      client, status: 200,
      headers: ["Content-Type": "application/vnd.apple.mpegurl", "Content-Length": "\(body.count)"],
      body: head ? nil : body)
  }

  /// JavaScript's rewriting of a playlist; nil when it refused it or didn't answer in time.
  private func rewrite(_ token: String, _ read: (url: String, body: String)) -> String? {
    lock.lock()
    requests += 1
    let request = "r\(requests)"
    var result: String?
    let answered = DispatchSemaphore(value: 0)
    answers[request] = (token, { body in
      result = body
      answered.signal()
    })
    lock.unlock()
    ask?(request, token, read.url, read.body)
    if answered.wait(timeout: .now() + Self.answerWait) == .timedOut {
      lock.lock()
      answers[request] = nil
      lock.unlock()
      return nil
    }
    return result
  }

  /// A whole playlist from `url`, after redirects: its final address and text.
  private func fetchPlaylist(_ url: URL, _ served: Served) -> (url: String, body: String)? {
    var request = URLRequest(url: url)
    for (name, value) in served.headers { request.setValue(value, forHTTPHeaderField: name) }
    // Bytes as the provider sends them, so the length it says is the length the TV gets.
    request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
    var result: (url: String, body: String)?
    let done = DispatchSemaphore(value: 0)
    let task = Self.session.dataTask(with: request) { data, response, _ in
      defer { done.signal() }
      if let data, data.count <= Self.playlistLimit,
        let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
        let body = String(data: data, encoding: .utf8)
      {
        result = ((http.url ?? url).absoluteString, body)
      }
    }
    guard let id = track(task, in: served) else { return nil }
    task.resume()
    done.wait()
    untrack(id, in: served)
    return result
  }

  /// Registers an upstream task so revoking cancels it; nil once revoked.
  private func track(_ task: URLSessionTask, in served: Served) -> Int? {
    lock.lock()
    defer { lock.unlock() }
    if served.revoked { return nil }
    taskIds += 1
    served.tasks[taskIds] = task
    return taskIds
  }

  private func untrack(_ id: Int, in served: Served) {
    lock.lock()
    served.tasks[id] = nil
    lock.unlock()
  }

  /// Streams one upstream response to the TV: its status, type, length and range, then its bytes.
  private func relay(
    _ client: Int32, _ url: URL, served: Served, range: String?, method: String
  ) {
    var request = URLRequest(url: url)
    request.httpMethod = method
    for (name, value) in served.headers { request.setValue(value, forHTTPHeaderField: name) }
    // Bytes as the provider sends them, so the length it says is the length the TV gets.
    request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
    if let range { request.setValue(range, forHTTPHeaderField: "Range") }
    let streaming = Streaming(client: client)
    let session = URLSession(
      configuration: Self.configuration, delegate: streaming, delegateQueue: nil)
    let task = session.dataTask(with: request)
    guard let id = track(task, in: served) else {
      session.invalidateAndCancel()
      return reply(client, status: 404, headers: [:], body: Data())
    }
    task.resume()
    streaming.done.wait()
    untrack(id, in: served)
    session.finishTasksAndInvalidate()
  }

  /// A copy on the phone, with one byte range when asked.
  private func file(_ client: Int32, _ url: URL, range: String?, head: Bool) {
    guard let handle = try? FileHandle(forReadingFrom: url),
      let size = (try? handle.seekToEnd()).map({ Int($0) })
    else { return reply(client, status: 404, headers: [:], body: Data()) }
    defer { try? handle.close() }
    var first = 0
    var last = size - 1
    var status = 200
    var headers = ["Content-Type": "video/mp4", "Accept-Ranges": "bytes"]
    if let range, let asked = Self.range(range) {
      guard asked.first < size else {
        return reply(
          client, status: 416, headers: ["Content-Range": "bytes */\(size)"], body: Data())
      }
      first = asked.first
      last = min(asked.last ?? size - 1, size - 1)
      status = 206
      headers["Content-Range"] = "bytes \(first)-\(last)/\(size)"
    }
    headers["Content-Length"] = "\(max(0, last - first + 1))"
    guard Self.send(Self.head(status, headers), to: client), !head else { return }
    try? handle.seek(toOffset: UInt64(first))
    var left = last - first + 1
    while left > 0 {
      guard let data = try? handle.read(upToCount: min(left, 256 * 1024)), !data.isEmpty,
        Self.send(data, to: client)
      else { return }
      left -= data.count
    }
  }

  private func reply(_ client: Int32, status: Int, headers: [String: String], body: Data?) {
    var all = headers
    if all["Content-Length"] == nil { all["Content-Length"] = "\(body?.count ?? 0)" }
    var out = Self.head(status, all)
    if let body { out.append(body) }
    _ = Self.send(out, to: client)
  }

  fileprivate static func head(_ status: Int, _ headers: [String: String]) -> Data {
    var all = headers
    all["Access-Control-Allow-Origin"] = "*"
    all["Access-Control-Allow-Methods"] = "GET, HEAD, OPTIONS"
    all["Access-Control-Allow-Headers"] = "Content-Type, Range, Accept-Encoding"
    all["Access-Control-Expose-Headers"] = "Content-Length, Content-Range"
    all["Connection"] = "close"
    let reason =
      [200: "OK", 204: "No Content", 206: "Partial Content", 404: "Not Found",
       416: "Range Not Satisfiable", 502: "Bad Gateway"][status] ?? "Error"
    let lines = all.map { "\($0.key): \($0.value)" }.sorted().joined(separator: "\r\n")
    return Data("HTTP/1.1 \(status) \(reason)\r\n\(lines)\r\n\r\n".utf8)
  }

  fileprivate static func send(_ data: Data, to client: Int32) -> Bool {
    data.withUnsafeBytes { all in
      var sent = 0
      while sent < all.count {
        let wrote = Darwin.send(client, all.baseAddress! + sent, all.count - sent, 0)
        if wrote <= 0 { return false }
        sent += wrote
      }
      return true
    }
  }

  /// One range of "bytes=<first>-[<last>]", or nil for anything else.
  static func range(_ value: String) -> (first: Int, last: Int?)? {
    guard value.hasPrefix("bytes=") else { return nil }
    let bounds = value.dropFirst(6).split(separator: "-", omittingEmptySubsequences: false)
    guard bounds.count == 2, let first = Int(bounds[0]) else { return nil }
    if bounds[1].isEmpty { return (first, nil) }
    guard let last = Int(bounds[1]), last >= first else { return nil }
    return (first, last)
  }

  // MARK: Shared pieces

  /// No cache, no cookies: nothing a provider sends is kept on the phone.
  private static let configuration: URLSessionConfiguration = {
    let made = URLSessionConfiguration.ephemeral
    made.urlCache = nil
    made.requestCachePolicy = .reloadIgnoringLocalCacheData
    made.httpCookieStorage = nil
    made.httpShouldSetCookies = false
    made.timeoutIntervalForRequest = 20
    return made
  }()
  private static let session = URLSession(configuration: configuration)

  private static func token() -> String? {
    var bytes = [UInt8](repeating: 0, count: 16)
    guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
      return nil
    }
    return bytes.map { String(format: "%02x", $0) }.joined()
  }

  /// The phone's IPv4 address on Wi-Fi when it is a private one; nil otherwise.
  static func wifiAddress() -> String? {
    var list: UnsafeMutablePointer<ifaddrs>?
    guard getifaddrs(&list) == 0, let first = list else { return nil }
    defer { freeifaddrs(list) }
    for entry in sequence(first: first, next: { $0.pointee.ifa_next }) {
      let interface = entry.pointee
      guard String(cString: interface.ifa_name) == "en0",
        let address = interface.ifa_addr, address.pointee.sa_family == UInt8(AF_INET)
      else { continue }
      var ipv4 = address.withMemoryRebound(to: sockaddr_in.self, capacity: 1) {
        $0.pointee.sin_addr
      }
      var text = [CChar](repeating: 0, count: Int(INET_ADDRSTRLEN))
      guard inet_ntop(AF_INET, &ipv4, &text, socklen_t(INET_ADDRSTRLEN)) != nil else { continue }
      let found = String(cString: text)
      let octets = found.split(separator: ".").compactMap { Int($0) }
      guard octets.count == 4 else { continue }
      let isPrivate =
        octets[0] == 10 || (octets[0] == 172 && (16...31).contains(octets[1]))
        || (octets[0] == 192 && octets[1] == 168)
      if isPrivate { return found }
    }
    return nil
  }
}

/// One upstream response streamed to the TV as it arrives; `done` once it ended either way.
private final class Streaming: NSObject, URLSessionDataDelegate {
  let client: Int32
  let done = DispatchSemaphore(value: 0)
  private var answered = false

  init(client: Int32) { self.client = client }

  func urlSession(
    _ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
  ) {
    guard let http = response as? HTTPURLResponse else { return completionHandler(.cancel) }
    var headers: [String: String] = [:]
    for name in ["Content-Type", "Content-Length", "Content-Range", "Accept-Ranges"] {
      if let value = http.value(forHTTPHeaderField: name) { headers[name] = value }
    }
    // A provider's failure reaches the TV as a status with no body, and nothing of its address.
    let ok = (200..<300).contains(http.statusCode)
    if !ok { headers = ["Content-Length": "0"] }
    answered = true
    let sent = CastRelay.send(CastRelay.head(ok ? http.statusCode : 502, headers), to: client)
    completionHandler(sent && ok ? .allow : .cancel)
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    if !CastRelay.send(data, to: client) { dataTask.cancel() }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    if !answered {
      _ = CastRelay.send(CastRelay.head(502, ["Content-Length": "0"]), to: client)
    }
    done.signal()
  }

  /// Redirects are followed here, so none reaches the TV.
  func urlSession(
    _ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void
  ) {
    completionHandler(request)
  }
}
