import Foundation

/// Why a session's file stopped coming, as the app classifies it. Never an address or the
/// system's own words, which can quote one.
enum SessionFailure {
  /// The provider answered with this HTTP status.
  case status(Int)
  case network(String)
  case unsupported(String)

  var record: [String: Any] {
    switch self {
    case .status(let status): return ["kind": "status", "status": status]
    case .network(let detail): return ["kind": "network", "detail": detail]
    case .unsupported(let detail): return ["kind": "unsupported", "detail": detail]
    }
  }
}

/// The bytes of one file, read by the C core from its work queue, a read at a time.
protocol ByteSource: AnyObject {
  /// The file's size, once `prepare` returned; -1 when unknown.
  var size: Int64 { get }
  var failure: SessionFailure? { get }
  /// Starts reading at the file's start, and waits for the answer. False when it failed.
  func prepare() -> Bool
  /// Reads up to `count` bytes at `offset`: the bytes read, 0 at the end, -1 on failure or close.
  func read(at offset: Int64, into buffer: UnsafeMutablePointer<UInt8>, count: Int) -> Int
  /// Stops: a waiting read returns -1, and nothing more is asked of the file.
  func close()
  /// Runs `ended` once, when nothing of the file is being read any more after `close`.
  func whenEnded(_ ended: @escaping () -> Void)
}

/// A downloaded copy, read from the phone.
final class CopyBytes: ByteSource {
  private let handle: FileHandle?
  private let lock = NSLock()
  private var closed = false
  let size: Int64
  private(set) var failure: SessionFailure?

  init(path: String) {
    handle = FileHandle(forReadingAtPath: path)
    let attributes = try? FileManager.default.attributesOfItem(atPath: path)
    size = (attributes?[.size] as? NSNumber)?.int64Value ?? -1
    if handle == nil { failure = .status(404) }
  }

  func prepare() -> Bool { handle != nil }

  func read(at offset: Int64, into buffer: UnsafeMutablePointer<UInt8>, count: Int) -> Int {
    lock.lock()
    defer { lock.unlock() }
    guard !closed, let handle else { return -1 }
    do {
      try handle.seek(toOffset: UInt64(offset))
      guard let data = try handle.read(upToCount: count) else { return 0 }
      data.copyBytes(to: buffer, count: data.count)
      return data.count
    } catch {
      failure = .unsupported("The copy on this phone can't be read.")
      return -1
    }
  }

  func close() {
    lock.lock()
    closed = true
    try? handle?.close()
    lock.unlock()
  }

  func whenEnded(_ ended: @escaping () -> Void) { ended() }
}

/// A provider's file, over one connection: at most one request is open at a time, a new one
/// starts only once URLSession said the last one ended, and a read near where the last stopped
/// carries on with the request that is open. Its body is taken as it is read, up to a bound.
final class ProviderBytes: NSObject, ByteSource, URLSessionDataDelegate {
  /// What the open request may hold unread before it is paused, and resumed below `low`. A move
  /// elsewhere in the file throws away at most this much.
  private static let high = 4 << 20
  private static let low = 1 << 20
  /// A read this far past the bytes received waits for them rather than asking again.
  private static let reach: Int64 = 512 << 10

  private let url: URL
  private let headers: [String: String]
  private let condition = NSCondition()
  private var session: URLSession!
  private var task: URLSessionDataTask?
  /// A request whose end URLSession hasn't told yet.
  private var open = false
  private var answered = false
  private var finished = false
  private var paused = false
  /// The open request is being cancelled: what it still delivers is dropped.
  private var stopping = false
  private var closed = false
  /// The file offset of `bytes[head]`.
  private var start: Int64 = 0
  private var bytes: [UInt8] = []
  private var head = 0
  private var ended: [() -> Void] = []
  private(set) var size: Int64 = -1
  private(set) var failure: SessionFailure?
  /// Requests sent, for the proof's record.
  private(set) var requests = 0

  init(url: URL, headers: [String: String]) {
    self.url = url
    self.headers = headers
    super.init()
    let configuration = URLSessionConfiguration.ephemeral
    configuration.httpMaximumConnectionsPerHost = 1
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    configuration.urlCache = nil
    let queue = OperationQueue()
    queue.maxConcurrentOperationCount = 1
    session = URLSession(configuration: configuration, delegate: self, delegateQueue: queue)
  }

  func prepare() -> Bool {
    condition.lock()
    defer { condition.unlock() }
    begin(at: 0)
    while !answered && failure == nil && !closed { condition.wait() }
    return answered && failure == nil && !closed
  }

  /// Sends a request for the file from `offset`; the lock is held and no request is open.
  private func begin(at offset: Int64) {
    var request = URLRequest(url: url)
    for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
    request.setValue("bytes=\(offset)-", forHTTPHeaderField: "Range")
    start = offset
    bytes.removeAll(keepingCapacity: true)
    head = 0
    answered = false
    finished = false
    paused = false
    stopping = false
    open = true
    requests += 1
    let made = session.dataTask(with: request)
    task = made
    made.resume()
  }

  private var available: Int { bytes.count - head }

  func read(at offset: Int64, into buffer: UnsafeMutablePointer<UInt8>, count: Int) -> Int {
    condition.lock()
    defer { condition.unlock() }
    while true {
      if closed || failure != nil { return -1 }
      if size >= 0 && offset >= size { return 0 }
      let end = start + Int64(available)
      if task != nil && offset >= start && offset <= end + (finished ? 0 : Self.reach) {
        if offset <= end {
          head += Int(offset - start)
          start = offset
          if available > 0 {
            let taken = min(count, available)
            bytes.withUnsafeBufferPointer { all in
              buffer.update(from: all.baseAddress! + head, count: taken)
            }
            head += taken
            start += Int64(taken)
            if head > Self.low {
              bytes.removeFirst(head)
              head = 0
            }
            if paused && available < Self.low {
              paused = false
              task?.resume()
            }
            return taken
          }
          if finished { return 0 }
        }
        condition.wait()
        continue
      }
      // Elsewhere in the file: the open request ends first, then one goes out from here.
      if open {
        stopTask()
        while open { condition.wait() }
        if closed { return -1 }
      }
      begin(at: offset)
    }
  }

  /// Cancels the open request. A suspended task reports its end only once resumed, which took
  /// seconds on the simulator, so it is resumed first; the lock is held.
  private func stopTask() {
    stopping = true
    if paused {
      paused = false
      task?.resume()
    }
    task?.cancel()
  }

  func close() {
    condition.lock()
    closed = true
    stopTask()
    let done = !open ? takeEnded() : []
    condition.broadcast()
    condition.unlock()
    done.forEach { $0() }
  }

  func whenEnded(_ then: @escaping () -> Void) {
    condition.lock()
    if closed && !open {
      condition.unlock()
      then()
      return
    }
    ended.append(then)
    condition.unlock()
  }

  /// The callbacks waiting for the end, once; the lock is held.
  private func takeEnded() -> [() -> Void] {
    let waiting = ended
    ended = []
    session.finishTasksAndInvalidate()
    return waiting
  }

  func urlSession(
    _ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
  ) {
    condition.lock()
    defer {
      condition.broadcast()
      condition.unlock()
    }
    guard dataTask === task, !closed, let http = response as? HTTPURLResponse else {
      completionHandler(.cancel)
      return
    }
    switch http.statusCode {
    case 206:
      // "bytes <first>-<last>/<size>": it must start where it was asked.
      let range = (http.value(forHTTPHeaderField: "Content-Range") ?? "")
        .replacingOccurrences(of: "bytes ", with: "")
      let parts = range.split(whereSeparator: { $0 == "-" || $0 == "/" })
      guard parts.count == 3, Int64(parts[0]) == start else {
        failure = .unsupported("The provider sent another part of the file than asked.")
        completionHandler(.cancel)
        return
      }
      if let total = Int64(parts[2]) { size = total }
    case 200 where start == 0:
      size = response.expectedContentLength
    case 200, 416:
      failure = .unsupported("The provider doesn't send part of a file, which seeking needs.")
      completionHandler(.cancel)
      return
    default:
      failure = .status(http.statusCode)
      completionHandler(.cancel)
      return
    }
    answered = true
    completionHandler(.allow)
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    condition.lock()
    defer {
      condition.broadcast()
      condition.unlock()
    }
    guard dataTask === task, !stopping else { return }
    bytes.append(contentsOf: data)
    if available > Self.high && !paused {
      paused = true
      dataTask.suspend()
    }
  }

  func urlSession(_ session: URLSession, task ended: URLSessionTask, didCompleteWithError error: Error?) {
    condition.lock()
    var done: [() -> Void] = []
    if ended === task {
      open = false
      finished = true
      if let error = error as NSError?, error.code != NSURLErrorCancelled, failure == nil, !closed {
        // The code says enough; the system's words can quote the address.
        failure = .network("(\(error.domain) \(error.code))")
      }
      if closed { done = takeEnded() }
    }
    condition.broadcast()
    condition.unlock()
    done.forEach { $0() }
  }
}
