// The system's list of AirPlay receivers, opened over the app's own button. An AVRoutePickerView
// for the helper's player sits in a see-through window on the button, and the list opens from it
// as if the viewer had pressed it. When that doesn't work, the picker's real button shows there
// for the viewer to press.
import AVKit
import AppKit

/// Seconds the list has to open after the press before the real button shows instead.
private let openDeadline: TimeInterval = 0.5

/// MR_STREAMER_AIRPLAY_PICKER=manual shows the real button from the start, to try that way.
private let alwaysManual =
  ProcessInfo.processInfo.environment["MR_STREAMER_AIRPLAY_PICKER"] == "manual"

final class RoutePicker: NSObject, AVRoutePickerViewDelegate {
  private let view = AVRoutePickerView()
  private let window: NSWindow
  /// The `showPicker` this picker answers, while it is up.
  private var request: Int?
  private var presenting = false
  private var outsideClicks: Any?

  init(player: AVPlayer) {
    window = NSWindow(
      contentRect: .zero, styleMask: .borderless, backing: .buffered, defer: true)
    super.init()
    window.isReleasedWhenClosed = false
    window.isOpaque = false
    window.hasShadow = false
    window.level = .floating
    // Over the app's window on every space, a full screen one included.
    window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    window.contentView = view
    view.player = player
    view.delegate = self
  }

  var isUp: Bool { request != nil }

  /// Opens the list at `anchor`, the app's button in the screen's points from its top left.
  func show(request: Int, anchor: CGRect) {
    finish()
    self.request = request
    presenting = false
    setButton(visible: false)
    window.setFrame(frame(for: anchor), display: true)
    window.orderFrontRegardless()
    // The list closes by itself on a click outside it only while this is the active app, and
    // the system doesn't always let a helper become that. So a click in any other app closes it.
    NSApp.activate(ignoringOtherApps: true)
    outsideClicks = NSEvent.addGlobalMonitorForEvents(
      matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown]
    ) { [weak self] _ in self?.finish(returnFocus: false) }
    // After this command's answer: the press can hold the main thread while the list is up.
    DispatchQueue.main.async { [self] in
      guard self.request == request else { return }
      if alwaysManual || !pressButton() {
        showButton(request, alwaysManual ? "asked for" : "the picker holds no button")
        return
      }
      DispatchQueue.main.asyncAfter(deadline: .now() + openDeadline) { [self] in
        if self.request == request && !presenting {
          showButton(request, "the list did not open")
        }
      }
    }
  }

  /// Closes the list and the window.
  func hide() {
    finish()
  }

  func routePickerViewWillBeginPresentingRoutes(_ routePickerView: AVRoutePickerView) {
    guard let request else { return }
    presenting = true
    emit("picker", ["request": request, "state": "opened"])
  }

  func routePickerViewDidEndPresentingRoutes(_ routePickerView: AVRoutePickerView) {
    presenting = false
    finish()
  }

  /// Presses the picker's button for the viewer. This is the helper's one step Apple doesn't
  /// document: AVRoutePickerView has no call that presents its routes, so this finds the control
  /// the view is built around and clicks it. False when the view holds none.
  private func pressButton() -> Bool {
    guard let button = control(in: view) else { return false }
    button.performClick(nil)
    return true
  }

  private func control(in view: NSView) -> NSControl? {
    for subview in view.subviews {
      if let control = subview as? NSControl ?? control(in: subview) { return control }
    }
    return nil
  }

  /// The way without the press: the picker's own button, white on black, for the viewer to click.
  private func showButton(_ request: Int, _ why: String) {
    setButton(visible: true)
    emit("picker", ["request": request, "state": "manual", "detail": why])
  }

  private func setButton(visible: Bool) {
    let states: [AVRoutePickerView.ButtonState] = [
      .normal, .normalHighlighted, .active, .activeHighlighted,
    ]
    for state in states {
      view.setRoutePickerButtonColor(visible ? .white : .clear, for: state)
    }
    view.isRoutePickerButtonBordered = false
    window.backgroundColor = visible ? .black : .clear
  }

  /// Takes the picker down and says so, once. `returnFocus` is off where the viewer clicked into
  /// another app, which then has the keyboard already.
  private func finish(returnFocus: Bool = true) {
    guard let request else { return }
    self.request = nil
    if let outsideClicks { NSEvent.removeMonitor(outsideClicks) }
    outsideClicks = nil
    // Closing the window the list hangs from closes the list with it.
    window.orderOut(nil)
    emit("picker", ["request": request, "state": "closed"])
    if returnFocus { giveFocusBack() }
  }

  /// Makes the app that started the helper the active one again, when the helper still is.
  private func giveFocusBack() {
    guard NSApp.isActive, let app = NSRunningApplication(processIdentifier: getppid()) else {
      return
    }
    if #available(macOS 14.0, *) {
      NSApp.yieldActivation(to: app)
      app.activate()
    } else {
      app.activate(options: [])
    }
  }

  /// Electron counts points from the top left of the primary display, downwards; AppKit from its
  /// bottom left, upwards. Both spaces span every display, so the display follows from the place.
  private func frame(for anchor: CGRect) -> NSRect {
    let primary = NSScreen.screens.first?.frame ?? .zero
    let frame = NSRect(
      x: anchor.minX, y: primary.maxY - anchor.maxY,
      width: max(anchor.width, 1), height: max(anchor.height, 1))
    if NSScreen.screens.contains(where: { $0.frame.intersects(frame) }) { return frame }
    note("The anchor is on no display; the list opens in the middle of the main one.")
    let main = (NSScreen.main ?? NSScreen.screens.first)?.frame ?? .zero
    return NSRect(x: main.midX - 22, y: main.midY - 22, width: 44, height: 44)
  }
}
