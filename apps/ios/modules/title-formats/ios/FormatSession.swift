import Foundation

/// One file played through the C core: its source, its title, the segments made last, and its
/// route on the loopback server. Everything of the title runs on `work`, one request at a time;
/// the source's reads block there while URLSession answers on its own queue.
final class FormatSession {
  /// The segments kept after they were made, for AVPlayer asking again. Each is bounded by the
  /// core (SEGMENT_BYTES_MOST), so this bounds what a session holds.
  private static let kept = 2

  enum Opened {
    case session(playlist: String)
    case direct
    case failed(SessionFailure)
    case closed
  }

  private let work = DispatchQueue(label: "app.mrstreamer.title-formats.session")
  private let lock = NSLock()
  private let source: ByteSource
  private let token: String
  private var title: OpaquePointer?
  private var store: [Int: Data] = [:]
  private var recent: [Int] = []
  private var init_: Data?
  private var playlist: Data?
  private var closed = false
  private var failure_: SessionFailure?
  private var sourceEnded = false
  private var titleFreed = false
  private var finished: [() -> Void] = []

  init(url: URL, headers: [String: String]) {
    source = url.isFileURL ? CopyBytes(path: url.path) : ProviderBytes(url: url, headers: headers)
    var random = [UInt8](repeating: 0, count: 16)
    _ = SecRandomCopyBytes(kSecRandomDefault, random.count, &random)
    token = random.map { String(format: "%02x", $0) }.joined()
    source.whenEnded { [weak self] in self?.ended(source: true) }
  }

  var failure: SessionFailure? {
    lock.lock()
    defer { lock.unlock() }
    return failure_ ?? source.failure
  }

  private func fail(_ failure: SessionFailure) {
    lock.lock()
    if failure_ == nil { failure_ = failure }
    lock.unlock()
  }

  /// Reads the file's header and index, then serves it. Calls `done` on the work queue.
  func open(_ done: @escaping (Opened) -> Void) {
    work.async { [self] in
      guard !isClosed, source.prepare() else {
        return done(isClosed ? .closed : .failed(failure ?? .network("")))
      }
      var callbacks = TitleHlsSource()
      callbacks.opaque = Unmanaged.passUnretained(self).toOpaque()
      callbacks.size = source.size
      callbacks.read_at = { opaque, offset, buffer, size in
        let session = Unmanaged<FormatSession>.fromOpaque(opaque!).takeUnretainedValue()
        return Int32(session.source.read(at: offset, into: buffer!, count: Int(size)))
      }
      var made: OpaquePointer?
      var detail = [CChar](repeating: 0, count: 256)
      let result = title_hls_open(&callbacks, &made, &detail, detail.count)
      lock.lock()
      let stopped = closed
      if !stopped { title = made }
      lock.unlock()
      if stopped {
        if let made { title_hls_close(made) }
        return done(.closed)
      }
      if result == TITLE_HLS_OK, let made {
        var size = 0
        let start = title_hls_init(made, &size)!
        init_ = Data(bytes: start, count: size)
        playlist = Data(String(cString: title_hls_playlist(made)).utf8)
        do {
          let port = try LoopbackServer.shared.start()
          LoopbackServer.shared.add(token) { [weak self] name, respond in
            guard let self else { return respond(.missing) }
            self.work.async { respond(self.answer(name)) }
          }
          return done(.session(playlist: "http://127.0.0.1:\(port)/\(token)/main.m3u8"))
        } catch {
          return done(.failed(.unsupported("The player's local server didn't start.")))
        }
      }
      switch result {
      case TITLE_HLS_DIRECT: done(.direct)
      case TITLE_HLS_INTERRUPTED: done(.closed)
      case TITLE_HLS_READ_FAILED: done(.failed(failure ?? .network("")))
      default: done(.failed(.unsupported(String(cString: detail))))
      }
    }
  }

  private var isClosed: Bool {
    lock.lock()
    defer { lock.unlock() }
    return closed
  }

  /// One of AVPlayer's requests, on the work queue.
  private func answer(_ name: String) -> LoopbackResponse {
    guard !isClosed, let title else { return .missing }
    switch name {
    case "main.m3u8":
      return LoopbackResponse(status: 200, type: "application/vnd.apple.mpegurl", body: playlist!)
    case "init.mp4":
      return LoopbackResponse(status: 200, type: "video/mp4", body: init_!)
    default:
      guard name.hasPrefix("s"), name.hasSuffix(".m4s"),
        let index = Int(name.dropFirst().dropLast(4))
      else { return .missing }
      if let kept = store[index] { return LoopbackResponse(status: 200, type: "video/mp4", body: kept) }
      var data: UnsafeMutablePointer<UInt8>?
      var size = 0
      var detail = [CChar](repeating: 0, count: 256)
      let result = title_hls_segment(title, Int32(index), &data, &size, &detail, detail.count)
      guard result == TITLE_HLS_OK, let data else {
        switch result {
        case TITLE_HLS_READ_FAILED: fail(source.failure ?? .network(""))
        case TITLE_HLS_UNSUPPORTED: fail(.unsupported(String(cString: detail)))
        default: break
        }
        return .failed
      }
      let made = Data(bytes: data, count: size)
      title_hls_free(data)
      store[index] = made
      recent.removeAll { $0 == index }
      recent.append(index)
      while recent.count > Self.kept { store[recent.removeFirst()] = nil }
      return LoopbackResponse(status: 200, type: "video/mp4", body: made)
    }
  }

  /// Stops serving and reading at once; the title is freed once its work queue is free.
  func close() {
    lock.lock()
    if closed {
      lock.unlock()
      return
    }
    closed = true
    let title = self.title
    lock.unlock()
    LoopbackServer.shared.remove(token)
    if let title { title_hls_interrupt(title) }
    source.close()
    work.async { [self] in
      lock.lock()
      let title = self.title
      self.title = nil
      lock.unlock()
      if let title { title_hls_close(title) }
      store = [:]
      ended(source: false)
    }
  }

  /// Calls `then` once the provider's request ended and the title is freed, after `close`.
  func whenClosed(_ then: @escaping () -> Void) {
    lock.lock()
    if sourceEnded && titleFreed {
      lock.unlock()
      return then()
    }
    finished.append(then)
    lock.unlock()
  }

  private func ended(source: Bool) {
    lock.lock()
    if source { sourceEnded = true } else { titleFreed = true }
    let done = sourceEnded && titleFreed ? finished : []
    if sourceEnded && titleFreed { finished = [] }
    lock.unlock()
    done.forEach { $0() }
  }
}
