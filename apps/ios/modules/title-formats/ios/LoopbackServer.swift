import Foundation
import Network

/// An answer to one request of AVPlayer's.
struct LoopbackResponse {
  let status: Int
  let type: String
  let body: Data

  static let missing = LoopbackResponse(status: 404, type: "text/plain", body: Data())
  static let failed = LoopbackResponse(status: 500, type: "text/plain", body: Data())
}

/// The HTTP server AVPlayer streams sessions from: on 127.0.0.1 only, GET and HEAD, each
/// session under an unguessable path of its own, removed when it closes. Nothing it serves
/// carries a login.
final class LoopbackServer {
  static let shared = LoopbackServer()

  typealias Handler = (_ name: String, _ respond: @escaping (LoopbackResponse) -> Void) -> Void

  private let queue = DispatchQueue(label: "app.mrstreamer.title-formats.server")
  private var listener: NWListener?
  private var port: UInt16 = 0
  private var routes: [String: Handler] = [:]

  /// The listening port, starting the server if it isn't running.
  func start() throws -> UInt16 {
    try queue.sync {
      if let listener, listener.state == .ready { return port }
      listener?.cancel()
      let parameters = NWParameters.tcp
      parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)
      parameters.acceptLocalOnly = true
      let made = try NWListener(using: parameters)
      let ready = DispatchSemaphore(value: 0)
      var failed = false
      made.stateUpdateHandler = { [weak self] state in
        switch state {
        case .ready:
          ready.signal()
        case .failed, .cancelled:
          failed = true
          ready.signal()
          self?.queue.async { if self?.listener === made { self?.listener = nil } }
        default:
          break
        }
      }
      made.newConnectionHandler = { [weak self] connection in self?.serve(connection) }
      made.start(queue: DispatchQueue(label: "app.mrstreamer.title-formats.listener"))
      ready.wait()
      guard !failed, let bound = made.port?.rawValue else {
        made.cancel()
        throw NSError(domain: "TitleFormats", code: 1)
      }
      listener = made
      port = bound
      return bound
    }
  }

  func add(_ token: String, _ handler: @escaping Handler) { queue.sync { routes[token] = handler } }
  func remove(_ token: String) { queue.sync { routes[token] = nil } }

  private func handler(for token: String) -> Handler? { queue.sync { routes[token] } }

  private func serve(_ connection: NWConnection) {
    connection.start(queue: DispatchQueue(label: "app.mrstreamer.title-formats.connection"))
    receive(connection, Data())
  }

  /// Reads one request's head, answers it, then the next on the same connection.
  private func receive(_ connection: NWConnection, _ pending: Data) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 16 * 1024) {
      [weak self] data, _, complete, error in
      guard let self else { return connection.cancel() }
      var buffer = pending
      if let data { buffer.append(data) }
      guard let end = buffer.range(of: Data("\r\n\r\n".utf8)) else {
        if complete || error != nil || buffer.count > 64 * 1024 { connection.cancel() }
        else { self.receive(connection, buffer) }
        return
      }
      let head = String(decoding: buffer[buffer.startIndex..<end.lowerBound], as: UTF8.self)
      let rest = Data(buffer[end.upperBound...])
      self.answer(head) { response, method, range in
        var body = response.body
        var status = response.status
        var lines = ["Content-Type: \(response.type)", "Accept-Ranges: bytes"]
        if let range, status == 200 {
          let last = min(range.upperBound, body.count - 1)
          if range.lowerBound < body.count, last >= range.lowerBound {
            lines.append("Content-Range: bytes \(range.lowerBound)-\(last)/\(body.count)")
            body = body.subdata(in: range.lowerBound..<(last + 1))
            status = 206
          } else {
            lines.append("Content-Range: bytes */\(body.count)")
            body = Data()
            status = 416
          }
        }
        lines.append("Content-Length: \(body.count)")
        let reason = [200: "OK", 206: "Partial Content", 404: "Not Found", 416: "Range Not Satisfiable"][status] ?? "Error"
        var out = Data("HTTP/1.1 \(status) \(reason)\r\n\(lines.joined(separator: "\r\n"))\r\n\r\n".utf8)
        if method != "HEAD" { out.append(body) }
        connection.send(content: out, completion: .contentProcessed { error in
          if error != nil { connection.cancel() } else { self.receive(connection, rest) }
        })
      }
    }
  }

  /// Parses the request line and Range, and asks the session it names.
  private func answer(
    _ head: String, _ respond: @escaping (LoopbackResponse, String, ClosedRange<Int>?) -> Void
  ) {
    let lines = head.components(separatedBy: "\r\n")
    let parts = lines.first?.split(separator: " ") ?? []
    guard parts.count >= 2, parts[0] == "GET" || parts[0] == "HEAD" else {
      return respond(.missing, "GET", nil)
    }
    let method = String(parts[0])
    let path = parts[1].split(separator: "?").first.map(String.init) ?? ""
    let segments = path.split(separator: "/").map(String.init)
    var range: ClosedRange<Int>?
    for line in lines.dropFirst() where line.lowercased().hasPrefix("range:") {
      let value = line.dropFirst(6).trimmingCharacters(in: .whitespaces)
      if value.hasPrefix("bytes=") {
        let bounds = value.dropFirst(6).split(separator: "-", omittingEmptySubsequences: false)
        if bounds.count == 2, let first = Int(bounds[0]) {
          range = first...(Int(bounds[1]) ?? Int.max - 1)
        }
      }
    }
    guard segments.count == 2, let handler = handler(for: segments[0]) else {
      return respond(.missing, method, nil)
    }
    handler(segments[1]) { respond($0, method, range) }
  }
}
