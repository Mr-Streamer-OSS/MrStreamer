// Mr. Streamer's AirPlay helper: the part of the app that plays on AirPlay receivers on macOS.
// Electron has no way to AirPlay a stream, so the app starts this small program, built by
// scripts/build-airplay-helper.sh, and speaks to it in JSON lines (Lines.swift): commands on
// stdin, events on stdout. It holds one AVPlayer that plays the address the app gives it on the
// receiver the viewer picks in the system's own list, and says everything it sees, so the app's
// log shows what happened. It uses documented AVFoundation and AVKit calls only, with the one
// exception Picker.swift names. It shows no Dock icon, menu or window besides the picker, and
// exits when the app closes its stdin.
import AVFoundation
import AppKit

let application = NSApplication.shared
application.setActivationPolicy(.accessory)

let routePlayer = RoutePlayer()
let routePicker = RoutePicker(player: routePlayer.player)
routePlayer.choosing = { routePicker.isUp }

let detector = AVRouteDetector()
NotificationCenter.default.addObserver(
  forName: .AVRouteDetectorMultipleRoutesDetectedDidChange, object: detector, queue: .main
) { _ in reportRoutes() }

// Whether the helper has the keyboard decides how the list takes clicks and closes, so say so.
for (name, text) in [
  (NSApplication.didBecomeActiveNotification, "The helper is the active app."),
  (NSApplication.didResignActiveNotification, "The helper is no longer the active app."),
] {
  NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { _ in
    note(text)
  }
}

func reportRoutes() {
  guard detector.isRouteDetectionEnabled else { return }
  emit("routes", ["available": detector.multipleRoutesDetected])
}

/// Looks for receivers while `on`. Detection starts from "none" and takes a moment to find one,
/// so "none" is said only once it has had a second.
func detect(_ on: Bool) {
  detector.isRouteDetectionEnabled = on
  guard on else { return }
  if detector.multipleRoutesDetected {
    reportRoutes()
  } else {
    DispatchQueue.main.asyncAfter(deadline: .now() + 1) { reportRoutes() }
  }
}

/// Runs one command and answers it. One for a load the player no longer holds answers and does
/// nothing.
func handle(_ command: [String: Any]) {
  guard let id = command["id"] as? Int else {
    emit("error", ["message": "A command had no id."])
    return
  }
  let name = command["cmd"] as? String ?? ""
  let generation = command["generation"] as? Int
  let current = generation != nil && generation == routePlayer.generation
  switch name {
  case "detect":
    detect(command["on"] as? Bool ?? false)
  case "showPicker":
    guard let anchor = command["anchor"] as? [String: Any],
      let x = anchor["x"] as? Double, let y = anchor["y"] as? Double,
      let width = anchor["width"] as? Double, let height = anchor["height"] as? Double
    else { return answer(id, error: "showPicker needs an anchor.") }
    routePlayer.holdPlaceholder()
    routePicker.show(
      request: command["request"] as? Int ?? id,
      anchor: CGRect(x: x, y: y, width: width, height: height))
  case "hidePicker":
    routePicker.hide()
  case "unload":
    routePlayer.unload()
  case "load":
    guard let generation,
      let url = (command["url"] as? String).flatMap(URL.init(string:)),
      url.scheme == "http" || url.scheme == "https"
    else { return answer(id, error: "load needs a generation and an http address.") }
    routePlayer.load(
      generation: generation, url: url, position: command["position"] as? Double ?? 0,
      paused: command["paused"] as? Bool ?? false, live: command["live"] as? Bool ?? false,
      subtitles: command["subtitles"] as? Bool ?? false)
  case "play":
    if current { routePlayer.play() }
  case "pause":
    if current { routePlayer.pause() }
  case "seek":
    guard let position = command["position"] as? Double else {
      return answer(id, error: "seek needs a position.")
    }
    if current { routePlayer.seek(to: position) }
  case "subtitles":
    if current { routePlayer.showSubtitles(command["on"] as? Bool ?? false) }
  case "stop":
    if current { routePlayer.stop() }
  case "volume":
    routePlayer.setVolume(level: command["level"] as? Double, muted: command["muted"] as? Bool)
  default:
    return answer(id, error: "Unknown command \(name).")
  }
  answer(id)
}

emit(
  "hello",
  [
    "protocol": protocolVersion,
    "pid": Int(getpid()),
    "system": ProcessInfo.processInfo.operatingSystemVersionString,
    "bundle": Bundle.main.bundleIdentifier ?? "",
    "probe": RouteProbe.chosen.rawValue,
  ])
routePlayer.reportVolume()
Placeholder.prepare()
readCommands(handle, beforeExit: Placeholder.remove)
application.run()
