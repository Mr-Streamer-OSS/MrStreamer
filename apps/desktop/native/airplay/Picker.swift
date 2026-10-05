// The system's list of AirPlay receivers, opened over the app's own button. An AVRoutePickerView
// for the helper's player sits in a see-through window on the button, and the list opens from it
// as if the viewer had pressed it. When that doesn't work, the picker's real button shows there
// for the viewer to press.
//
// The request and the list are kept apart. The request is the app's `showPicker`, which ends with
// one `closed`. The list is AVKit's, and only AVKit says when it is up: it comes a moment after
// the press that opens it, and goes a moment after the press that closes it, or by itself. The
// window stays in place until the list said it went. Taken out of sight first, the list stays up
// unseen whenever this isn't the active app, and the next press closes it instead of opening it.
import AVKit
import AppKit

/// Seconds the list has to open after the press before the real button shows instead.
private let openDeadline: TimeInterval = 0.5

/// Seconds the list has to say it went: after the press that closes it, or after this stopped
/// being the active app, which closes it without a press.
private let closeDeadline: TimeInterval = 0.5

/// The most presses one `showPicker` gets. Opening and closing take two; a list left up from
/// before, or one that came up late, takes a few more. Past that nothing is pressed any more.
private let pressLimit = 6

/// MR_STREAMER_AIRPLAY_PICKER=manual shows the real button from the start, to try that way.
private let alwaysManual =
  ProcessInfo.processInfo.environment["MR_STREAMER_AIRPLAY_PICKER"] == "manual"

final class RoutePicker: NSObject, AVRoutePickerViewDelegate {
  /// What the picker waits to hear from the list.
  private enum Wait {
    /// The press that opens it was made.
    case opening
    /// The press that closes it was made.
    case closing
    /// It closes by itself, since this stopped being the active app.
    case leaving
  }

  private let view = AVRoutePickerView()
  private let window: NSWindow
  /// The `showPicker` the app waits on, until it is told `closed`.
  private var request: Int?
  /// The app was told the list is up for that request.
  private var told = false
  /// The picker's real button shows for that request, and nothing is pressed for it any more.
  private var manual = false
  /// Presses made since that request came.
  private var presses = 0
  /// The list is on screen, by its own word.
  private var up = false
  /// This stopped being the active app while the list was up, so the list closes by itself.
  private var leaving = false
  private var wait: Wait?
  /// Counts the waits, so a deadline that ran out on an earlier one does nothing.
  private var waits = 0
  private var outsideClicks: Any?
  private var otherApps: NSObjectProtocol?

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
    let center = NotificationCenter.default
    center.addObserver(
      forName: NSApplication.didResignActiveNotification, object: nil, queue: .main
    ) { [weak self] _ in
      guard let self else { return }
      self.leaving = self.up
    }
    center.addObserver(
      forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main
    ) { [weak self] _ in self?.leaving = false }
  }

  var isUp: Bool { request != nil }

  /// Opens the list at `anchor`, the app's button in the screen's points from its top left. A
  /// list still up from the request before moves there and answers this one.
  func show(request: Int, anchor: CGRect) {
    finish(returnFocus: false)
    guard let place = frame(for: anchor) else {
      note("There is no display to open the list on.")
      return emit("picker", ["request": request, "state": "closed"])
    }
    self.request = request
    presses = 0
    setButton(visible: false)
    window.setFrame(place, display: true)
    window.orderFrontRegardless()
    // The list closes by itself on a click outside it only while this is the active app, and
    // the system doesn't always let a helper become that. So `watch` closes it as well.
    NSApp.activate(ignoringOtherApps: true)
    watch()
    note("Request \(request) asks for the list: \(standing).")
    settleSoon()
  }

  /// Ends the request. The list closes, then the window goes.
  func hide() {
    finish()
  }

  func routePickerViewWillBeginPresentingRoutes(_ routePickerView: AVRoutePickerView) {
    heard()
    up = true
    leaving = false
    if placed {
      note("The list opens: \(standing).")
      tell()
    } else {
      // Seen once in a lab: a list that opens while its window is on no display lands in the
      // display's bottom left corner. Nobody chooses there, so it closes.
      note("The list opens out of place and closes: \(standing).")
      finish()
    }
    settleSoon()
  }

  func routePickerViewDidEndPresentingRoutes(_ routePickerView: AVRoutePickerView) {
    heard()
    up = false
    leaving = false
    // The list the app was told of went: the viewer picked in it, or closed it.
    if told { finish() }
    settleSoon()
  }

  /// Brings the list to what is wanted: up for a request that waits, and down with the window
  /// out of sight without one. Does nothing while the list still owes its word on a press.
  private func settle() {
    guard wait == nil else { return }
    if up {
      if told { return }
      // Pressed while it closes by itself, it would open again.
      if leaving { return expect(.leaving) }
      if request != nil { tell() } else { press(.closing) }
    } else if let request {
      if !manual { open(request) }
    } else {
      window.orderOut(nil)
    }
  }

  /// Tells the app the list is up for the request that waits, once.
  private func tell() {
    guard let request, !told else { return }
    told = true
    emit("picker", ["request": request, "state": "opened"])
  }

  /// Settles on a turn of the main queue of its own: after a command's answer, and never inside
  /// the list's own word, where a press could reach a list that is half way up or down.
  private func settleSoon() {
    DispatchQueue.main.async { [self] in settle() }
  }

  /// Presses the list open for `request`, or shows the real button where a press is not wanted.
  private func open(_ request: Int) {
    guard placed else {
      note("The picker's window is out of place, so the list stays shut: \(standing).")
      return finish()
    }
    if alwaysManual { return showButton(request, "asked for") }
    press(.opening)
  }

  /// Presses the picker's button for the viewer and waits for the list's word on it. This is the
  /// helper's one step Apple doesn't document: AVRoutePickerView has no call that presents its
  /// routes or takes them down, so this finds the control the view is built around and clicks
  /// it. A press opens the list, and a press while it is up closes it.
  private func press(_ wait: Wait) {
    presses += 1
    guard presses <= pressLimit else { return giveUp("the list did not follow the presses") }
    guard let button = control(in: view) else { return giveUp("the picker holds no button") }
    // Before the click: the list may say its word inside it.
    expect(wait)
    button.performClick(nil)
  }

  private func control(in view: NSView) -> NSControl? {
    for subview in view.subviews {
      if let control = subview as? NSControl ?? control(in: subview) { return control }
    }
    return nil
  }

  /// Waits for the list's word, no longer than `wait` gets.
  private func expect(_ wait: Wait) {
    self.wait = wait
    waits += 1
    let mine = waits
    let deadline = wait == .opening ? openDeadline : closeDeadline
    DispatchQueue.main.asyncAfter(deadline: .now() + deadline) { [self] in
      if waits == mine { ranOut(wait) }
    }
  }

  /// The list said it came or went, which ends the wait there was.
  private func heard() {
    wait = nil
    waits += 1
  }

  /// The list said nothing in time.
  private func ranOut(_ wait: Wait) {
    self.wait = nil
    switch wait {
    case .opening:
      giveUp("the list did not open")
    case .closing:
      giveUp("the list did not close")
    case .leaving:
      // It stayed up after all, and takes a press.
      leaving = false
      settle()
    }
  }

  /// Stops pressing. Nothing says whether a list is still up, so it counts as gone: a request
  /// that waits gets the real button, and without one the window goes.
  private func giveUp(_ why: String) {
    up = false
    if let request { return showButton(request, why) }
    note("The picker stops here: \(why).")
    window.orderOut(nil)
  }

  /// The way without the press: the picker's own button, white on black, for the viewer to click.
  private func showButton(_ request: Int, _ why: String) {
    manual = true
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

  /// Ends the request when the viewer goes to another app: with a press there, or by bringing it
  /// to the front without one, as with Command-Tab. The list closes by itself on those only
  /// while this is the active app.
  private func watch() {
    outsideClicks = NSEvent.addGlobalMonitorForEvents(
      matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown]
    ) { [weak self] _ in self?.wentElsewhere("A press in another app") }
    otherApps = NSWorkspace.shared.notificationCenter.addObserver(
      forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
    ) { [weak self] notice in
      let app = notice.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
      // Only an app with a Dock icon counts as the viewer going elsewhere. This helper has
      // none, and neither have the system's own agents, whose dialogs may belong to the list.
      // Nor the app that started this helper: it gets the front back from a list that closed
      // just before this one.
      guard let app, app.activationPolicy == .regular, app.processIdentifier != getppid() else {
        return
      }
      self?.wentElsewhere("Another app came to the front")
    }
  }

  private func stopWatching() {
    if let outsideClicks { NSEvent.removeMonitor(outsideClicks) }
    if let otherApps { NSWorkspace.shared.notificationCenter.removeObserver(otherApps) }
    outsideClicks = nil
    otherApps = nil
  }

  private func wentElsewhere(_ how: String) {
    guard request != nil else { return }
    note("\(how), so the list closes.")
    // That takes the front from this app when it has it, and the list then closes by itself.
    if NSApp.isActive { leaving = up }
    finish(returnFocus: false)
  }

  /// Ends the request and says so, once. The list and the window follow in `settle`.
  /// `returnFocus` is off where the viewer went to another app, which has the keyboard already.
  private func finish(returnFocus: Bool = true) {
    guard let request else { return }
    self.request = nil
    told = false
    manual = false
    stopWatching()
    emit("picker", ["request": request, "state": "closed"])
    settleSoon()
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

  /// Whether the window is where a list can hang from it: on screen, on a display.
  private var placed: Bool { window.isVisible && window.screen != nil }

  /// Where the picker stands, for the log: places on screen, and nothing of the viewer's.
  private var standing: String {
    let display =
      window.screen.map { "display \(text($0.frame)) at \($0.backingScaleFactor)x" }
      ?? "no display"
    return "window \(text(window.frame)) \(window.isVisible ? "shown" : "hidden") on \(display), "
      + "this app \(NSApp.isActive ? "active" : "not active")"
  }

  private func text(_ rect: NSRect) -> String {
    "\(Int(rect.minX)),\(Int(rect.minY)) \(Int(rect.width))x\(Int(rect.height))"
  }

  /// Electron counts points from the top left of the primary display, downwards; AppKit from its
  /// bottom left, upwards. Both spaces span every display, so the display follows from the place.
  /// Nil when the system names no display.
  private func frame(for anchor: CGRect) -> NSRect? {
    guard let primary = NSScreen.screens.first?.frame else { return nil }
    let frame = NSRect(
      x: anchor.minX, y: primary.maxY - anchor.maxY,
      width: max(anchor.width, 1), height: max(anchor.height, 1))
    if NSScreen.screens.contains(where: { $0.frame.intersects(frame) }) { return frame }
    note("The anchor is on no display; the list opens in the middle of the main one.")
    let main = NSScreen.main?.frame ?? primary
    return NSRect(x: main.midX - 22, y: main.midY - 22, width: 44, height: 44)
  }
}
