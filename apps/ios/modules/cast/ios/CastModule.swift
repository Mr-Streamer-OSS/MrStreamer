import ExpoModulesCore
import Foundation
import UIKit

/**
 Play on TV for `src/cast.ts`, with no Google SDK: browsing for Cast TVs while the chooser is open
 (`CastBrowser`), the TLS connection to one that carries the protocol's bytes (`CastChannel`), and
 the relay the TV reads media from (`CastRelay`). What the protocol says, and every playlist's
 rewriting, is decided in JavaScript; nothing here plays or decides what a TV gets.

 The TV plays only while the app is open. Leaving it with a connection open, iOS is asked for time
 in the background at once and JavaScript is told (`onBackground`) to stop the TV and give the time
 back. When iOS gives none, or the time runs out, every connection and relay token closes here.
 */
public class CastModule: Module {
  private let browser = CastBrowser()
  /// Open channels by JavaScript's name for them; touched on the main queue only.
  private var channels: [String: CastChannel] = [:]
  private var background: UIBackgroundTaskIdentifier = .invalid
  private var observer: NSObjectProtocol?

  public func definition() -> ModuleDefinition {
    Name("Cast")

    /// `onBrowse { state, tvs }`; `onData { channel, data }` in base64; `onClosed { channel }`;
    /// `onPlaylist { request, token, url, body }`, answered with `answer`; `onBackground {}`.
    Events("onBrowse", "onData", "onClosed", "onPlaylist", "onBackground")

    OnCreate {
      self.browser.report = { [weak self] state, tvs in
        self?.sendEvent("onBrowse", ["state": state, "tvs": tvs])
      }
      CastRelay.shared.ask = { [weak self] request, token, url, body in
        self?.sendEvent(
          "onPlaylist", ["request": request, "token": token, "url": url, "body": body])
      }
      self.observer = NotificationCenter.default.addObserver(
        forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main
      ) { [weak self] _ in self?.leftApp() }
    }

    OnDestroy {
      DispatchQueue.main.async {
        if let observer = self.observer { NotificationCenter.default.removeObserver(observer) }
        self.browser.stop()
        self.closeEverything()
      }
    }

    Function("browse") {
      DispatchQueue.main.async { self.browser.start() }
    }

    Function("stopBrowsing") {
      DispatchQueue.main.async { self.browser.stop() }
    }

    /// Opens channel `channel` to the TV `device` that browsing found. Rejects when it doesn't open.
    AsyncFunction("connect") { (channel: String, device: String, promise: Promise) in
      DispatchQueue.main.async {
        guard let endpoint = self.browser.endpoint(device) else {
          return promise.reject("ERR_CAST_GONE", "That TV is no longer on the network.")
        }
        let opened = CastChannel(
          endpoint: endpoint,
          data: { [weak self] data in
            self?.sendEvent("onData", ["channel": channel, "data": data.base64EncodedString()])
          },
          closed: { [weak self] in
            guard let self else { return }
            self.channels[channel] = nil
            self.sendEvent("onClosed", ["channel": channel])
          })
        self.channels[channel] = opened
        opened.open { failure in
          if let failure {
            promise.reject("ERR_CAST_CONNECT", failure)
          } else {
            promise.resolve(nil)
          }
        }
      }
    }

    Function("write") { (channel: String, data: String) in
      guard let bytes = Data(base64Encoded: data) else { return }
      DispatchQueue.main.async { self.channels[channel]?.write(bytes) }
    }

    Function("disconnect") { (channel: String) in
      DispatchQueue.main.async { self.channels.removeValue(forKey: channel)?.close() }
    }

    /// Serves `url` as route "0" of a new token: `{ address, token }`, or null with no Wi-Fi.
    AsyncFunction("serve") {
      (url: String, headers: [String: String]?, playlist: Bool, promise: Promise) in
      guard let address = URL(string: url) else { return promise.resolve(nil) }
      let served = CastRelay.shared.serve(address, headers: headers ?? [:], playlist: playlist)
      promise.resolve(served.map { ["address": $0.address, "token": $0.token] })
    }

    Function("route") { (token: String, routes: [RelayRoute]) in
      CastRelay.shared.add(routes, to: token)
    }

    /// A playlist route read as the TV would read it: `{ url, body }`, or null.
    AsyncFunction("read") { (token: String, id: String, promise: Promise) in
      CastRelay.shared.read(token, id) { found in
        promise.resolve(found.map { ["url": $0.url, "body": $0.body] })
      }
    }

    Function("answer") { (request: String, body: String?) in
      CastRelay.shared.answer(request, body)
    }

    /// Resolves once every request under the token, to the TV and upstream, ended.
    AsyncFunction("revoke") { (token: String, promise: Promise) in
      CastRelay.shared.revoke(token) { promise.resolve(nil) }
    }

    Function("endBackground") {
      DispatchQueue.main.async { self.endBackground() }
    }
  }

  /// The app left the foreground: with a TV connected, hold time to stop it, or stop it here.
  private func leftApp() {
    guard !channels.isEmpty, background == .invalid else { return }
    background = UIApplication.shared.beginBackgroundTask(withName: "Stop playing on TV") {
      [weak self] in
      self?.closeEverything()
      self?.endBackground()
    }
    sendEvent("onBackground", [:])
    if background == .invalid { closeEverything() }
  }

  private func endBackground() {
    guard background != .invalid else { return }
    UIApplication.shared.endBackgroundTask(background)
    background = .invalid
  }

  /// Cuts every channel and relay token at once, for when JavaScript can't stop them in order.
  private func closeEverything() {
    let open = channels
    channels = [:]
    for (name, channel) in open {
      channel.close()
      sendEvent("onClosed", ["channel": name])
    }
    CastRelay.shared.revokeAll()
  }
}

/// A route JavaScript adds under a token: its id, the address it reads, and whether it's a
/// playlist the relay has rewritten before the TV gets it.
struct RelayRoute: Record {
  @Field var id: String = ""
  @Field var url: String = ""
  @Field var playlist: Bool = false
}
