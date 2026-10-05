// The helper's side of its JSON lines: events out on stdout, commands in on stdin, one object per
// line. apps/desktop/src/main/receivers/airplay/protocol.ts holds the app's side.
import Foundation

/// Said in `hello`. The app refuses a helper that speaks another.
let protocolVersion = 1

/// The longest command line taken, in bytes. A longer one is dropped whole.
let maxLineLength = 64 * 1024

private let started = ProcessInfo.processInfo.systemUptime
private let outputLock = NSLock()

/// Writes one event. `t` is milliseconds since the helper started, so a log shows how long each
/// step took.
func emit(_ type: String, _ fields: [String: Any] = [:]) {
  var event = fields
  event["type"] = type
  event["t"] = Int((ProcessInfo.processInfo.systemUptime - started) * 1000)
  guard
    var line = try? JSONSerialization.data(
      withJSONObject: event, options: [.sortedKeys, .withoutEscapingSlashes])
  else { return }
  line.append(0x0A)
  outputLock.lock()
  defer { outputLock.unlock() }
  line.withUnsafeBytes { bytes in
    var written = 0
    while written < bytes.count {
      let count = write(STDOUT_FILENO, bytes.baseAddress! + written, bytes.count - written)
      if count <= 0 { return }
      written += count
    }
  }
}

/// Something worth a line in the app's log that no command or state change covers.
func note(_ message: String) {
  emit("log", ["message": message])
}

/// The one answer every command with an id gets.
func answer(_ id: Int, error: String? = nil) {
  var fields: [String: Any] = ["id": id, "ok": error == nil]
  if let error { fields["error"] = error }
  emit("answer", fields)
}

/// Reads commands on a thread of its own until stdin closes, which ends the helper: it never
/// outlives the app that started it. `quit` ends it from here too, so it exits at once even while
/// the main thread is held up. Every other command goes to `handle` on the main thread.
func readCommands(_ handle: @escaping ([String: Any]) -> Void, beforeExit: @escaping () -> Void) {
  Thread.detachNewThread {
    var pending = Data()
    var skipping = false
    var chunk = [UInt8](repeating: 0, count: 16 * 1024)
    while true {
      let count = read(STDIN_FILENO, &chunk, chunk.count)
      if count < 0 && errno == EINTR { continue }
      if count <= 0 { break }
      pending.append(contentsOf: chunk[0..<count])
      while let end = pending.firstIndex(of: 0x0A) {
        let line = Data(pending[pending.startIndex..<end])
        pending = Data(pending[(end + 1)...])
        if skipping {
          // The rest of a line already refused.
          skipping = false
        } else if line.count > maxLineLength {
          refuseLine()
        } else if !line.isEmpty {
          take(line, handle, beforeExit)
        }
      }
      if pending.count > maxLineLength {
        pending.removeAll()
        if !skipping { refuseLine() }
        skipping = true
      }
    }
    beforeExit()
    _exit(0)
  }
}

private func refuseLine() {
  emit("error", ["message": "A command line was too long."])
}

private func take(
  _ line: Data, _ handle: @escaping ([String: Any]) -> Void, _ beforeExit: () -> Void
) {
  guard let command = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any] else {
    emit("error", ["message": "A command line was not a JSON object."])
    return
  }
  if command["cmd"] as? String == "quit" {
    if let id = command["id"] as? Int { answer(id) }
    beforeExit()
    _exit(0)
  }
  DispatchQueue.main.async { handle(command) }
}
