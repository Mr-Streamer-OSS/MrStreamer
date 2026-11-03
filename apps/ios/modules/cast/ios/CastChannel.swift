import Foundation
import Network

/// One TLS connection to a Cast TV's port 8009, carrying bytes both ways. Framing, messages and
/// the heartbeat are JavaScript's (`src/cast.ts`).
///
/// The TV's certificate isn't verified: a Cast TV presents a self-signed one that chains to no
/// public CA, and telling a real TV from an impostor takes Cast device authentication, which this
/// sender doesn't ask for. TLS only keeps the channel from being read in passing; whatever answers
/// gets the relay's address for one load and the title's name, never a provider's address.
final class CastChannel {
  private let connection: NWConnection
  private let data: (Data) -> Void
  private let closed: () -> Void
  private var opening: ((String?) -> Void)?
  private var ended = false

  /// `data` and `closed` are told on the main queue; `closed` once, unless `close` came first.
  init(endpoint: NWEndpoint, data: @escaping (Data) -> Void, closed: @escaping () -> Void) {
    let tls = NWProtocolTLS.Options()
    sec_protocol_options_set_verify_block(
      tls.securityProtocolOptions, { _, _, complete in complete(true) }, .main)
    let parameters = NWParameters(tls: tls, tcp: NWProtocolTCP.Options())
    parameters.includePeerToPeer = false
    connection = NWConnection(to: endpoint, using: parameters)
    self.data = data
    self.closed = closed
  }

  /// Opens the connection; `done` gets nil once it's ready, else why it didn't open.
  func open(_ done: @escaping (String?) -> Void) {
    opening = done
    connection.stateUpdateHandler = { [weak self] state in
      guard let self else { return }
      switch state {
      case .ready:
        self.opening?(nil)
        self.opening = nil
        self.receive()
      case .waiting(let error), .failed(let error):
        self.fail(error.localizedDescription)
      case .cancelled:
        self.fail("cancelled")
      default:
        break
      }
    }
    connection.start(queue: .main)
  }

  func write(_ bytes: Data) {
    guard !ended else { return }
    connection.send(content: bytes, completion: .contentProcessed { [weak self] error in
      if error != nil { self?.fail("write failed") }
    })
  }

  /// Closes it without telling `closed`.
  func close() {
    ended = true
    opening = nil
    connection.cancel()
  }

  private func fail(_ why: String) {
    if let opening {
      self.opening = nil
      ended = true
      connection.cancel()
      return opening(why)
    }
    guard !ended else { return }
    ended = true
    connection.cancel()
    closed()
  }

  private func receive() {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) {
      [weak self] content, _, complete, error in
      guard let self, !self.ended else { return }
      if let content, !content.isEmpty { self.data(content) }
      if complete || error != nil { return self.fail("closed") }
      self.receive()
    }
  }
}
