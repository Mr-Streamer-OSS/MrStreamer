import Foundation
import Network

/// Browses `_googlecast._tcp` on the local network while the TV chooser is open. iOS asks for
/// Local Network the first time it starts, never before. Speakers and groups without a screen
/// are left out, by the `ca` capability bits a Cast device announces.
final class CastBrowser {
  /// Told on the main queue: "searching" with the TVs found, "denied" or "failed".
  var report: ((_ state: String, _ tvs: [[String: Any]]) -> Void)?

  private var browser: NWBrowser?
  /// Every TV seen, by its id, kept after browsing stops so a chosen one can still be reached.
  private var endpoints: [String: NWEndpoint] = [:]

  /// kDNSServiceErr_PolicyDenied: Local Network is off for the app in Settings.
  private static let denied: DNSServiceErrorType = -65570
  /// The `ca` bit a device with a screen sets.
  private static let videoOut = 1

  func start() {
    guard browser == nil else { return }
    let parameters = NWParameters()
    parameters.includePeerToPeer = false
    let made = NWBrowser(
      for: .bonjourWithTXTRecord(type: "_googlecast._tcp", domain: nil), using: parameters)
    made.stateUpdateHandler = { [weak self] state in
      switch state {
      case .waiting(let error), .failed(let error):
        if case .dns(let code) = error, code == Self.denied {
          self?.report?("denied", [])
        } else if case .failed = state {
          self?.report?("failed", [])
        }
      default:
        break
      }
    }
    made.browseResultsChangedHandler = { [weak self] results, _ in self?.found(results) }
    made.start(queue: .main)
    browser = made
  }

  func stop() {
    browser?.cancel()
    browser = nil
  }

  func endpoint(_ id: String) -> NWEndpoint? { endpoints[id] }

  private func found(_ results: Set<NWBrowser.Result>) {
    var tvs: [[String: Any]] = []
    for result in results {
      guard case .service(let name, _, _, _) = result.endpoint else { continue }
      var text: [String: String] = [:]
      if case .bonjour(let record) = result.metadata { text = record.dictionary }
      if let capabilities = text["ca"].flatMap(Int.init), capabilities & Self.videoOut == 0 {
        continue
      }
      let id = text["id"] ?? name
      endpoints[id] = result.endpoint
      tvs.append(["id": id, "name": text["fn"] ?? name, "model": text["md"] ?? NSNull()])
    }
    tvs.sort { ($0["name"] as? String ?? "") < ($1["name"] as? String ?? "") }
    report?("searching", tvs)
  }
}
