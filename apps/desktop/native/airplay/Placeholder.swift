// How the helper learns that the viewer chose a route before the app has sent it any media.
//
// macOS has no call that names the route a player uses. The one documented sign is AVPlayer's
// isExternalPlaybackActive, "whether the player is currently playing video in external playback
// mode", and a player that holds no video has nothing to play there. So while the viewer chooses,
// and whenever a receiver is connected with nothing loaded, the player holds a placeholder: two
// seconds of black picture with no sound track, written here, never anything of the app's.
//
// None of this could be tried against a receiver. `RouteProbe.chosen` is the one place to change
// it, and MR_STREAMER_AIRPLAY_PROBE picks another way for one run without a new build.
import AVFoundation

enum RouteProbe: String {
  /// The placeholder held on its first frame. Nothing plays, here or there.
  case paused
  /// The placeholder playing in a loop, for a receiver that only starts on an item that plays.
  /// Media then also starts before external playback shows, muted until it does.
  case playing
  /// No placeholder: the route shows only once media is loaded, if it shows at all.
  case none

  static let chosen =
    RouteProbe(rawValue: ProcessInfo.processInfo.environment["MR_STREAMER_AIRPLAY_PROBE"] ?? "")
    ?? .paused
}

enum Placeholder {
  private static let file = URL(fileURLWithPath: NSTemporaryDirectory())
    .appendingPathComponent("MrStreamerAirPlay-\(getpid()).mp4")
  private static let queue = DispatchQueue(label: "app.mrstreamer.player.airplay.placeholder")
  private static var asset: AVURLAsset?

  /// Writes the clip in the background, at start, so the first picker doesn't wait for it.
  static func prepare() {
    guard RouteProbe.chosen != .none else { return }
    queue.async {
      let began = ProcessInfo.processInfo.systemUptime
      do {
        try write()
        asset = AVURLAsset(url: file)
        let size = (try? file.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0
        let took = Int((ProcessInfo.processInfo.systemUptime - began) * 1000)
        note("The placeholder is \(size) bytes, written in \(took) ms.")
      } catch {
        note("The placeholder could not be written: \(describe(error))")
      }
    }
  }

  /// A new item of the clip, or nil when there is none: an item belongs to one place in a player.
  static func item() -> AVPlayerItem? {
    queue.sync { asset }.map { AVPlayerItem(asset: $0) }
  }

  /// Takes the clip off the disk, as the helper exits.
  static func remove() {
    try? FileManager.default.removeItem(at: file)
  }

  private static func write() throws {
    let (width, height, frames, rate) = (1280, 720, 20, CMTimeScale(10))
    try? FileManager.default.removeItem(at: file)
    let writer = try AVAssetWriter(outputURL: file, fileType: .mp4)
    let input = AVAssetWriterInput(
      mediaType: .video,
      outputSettings: [
        AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: width, AVVideoHeightKey: height,
      ])
    let adaptor = AVAssetWriterInputPixelBufferAdaptor(
      assetWriterInput: input,
      sourcePixelBufferAttributes: [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
        kCVPixelBufferWidthKey as String: width,
        kCVPixelBufferHeightKey as String: height,
      ])
    writer.add(input)
    guard writer.startWriting() else { throw writer.error ?? CocoaError(.fileWriteUnknown) }
    writer.startSession(atSourceTime: .zero)

    var black: CVPixelBuffer?
    CVPixelBufferCreate(nil, width, height, kCVPixelFormatType_32BGRA, nil, &black)
    guard let black else { throw CocoaError(.fileWriteUnknown) }
    CVPixelBufferLockBaseAddress(black, [])
    memset(CVPixelBufferGetBaseAddress(black), 0, CVPixelBufferGetDataSize(black))
    CVPixelBufferUnlockBaseAddress(black, [])

    let finished = DispatchSemaphore(value: 0)
    var frame = 0
    input.requestMediaDataWhenReady(on: DispatchQueue(label: "placeholder.frames")) {
      while input.isReadyForMoreMediaData {
        if frame == frames {
          input.markAsFinished()
          writer.endSession(atSourceTime: CMTime(value: CMTimeValue(frames), timescale: rate))
          writer.finishWriting { finished.signal() }
          return
        }
        adaptor.append(black, withPresentationTime: CMTime(value: CMTimeValue(frame), timescale: rate))
        frame += 1
      }
    }
    finished.wait()
    guard writer.status == .completed else { throw writer.error ?? CocoaError(.fileWriteUnknown) }
  }
}

/// An error as one line for the app: what it says, where it comes from, and what lies under it.
func describe(_ error: Error?) -> String {
  guard let error = error as NSError? else { return "The player gave no reason." }
  var text = "\(error.localizedDescription) (\(error.domain) \(error.code))"
  if let reason = error.localizedFailureReason { text += " \(reason)" }
  if let under = error.userInfo[NSUnderlyingErrorKey] as? NSError,
    under.domain != error.domain || under.code != error.code
  {
    text += " \(under.localizedDescription) (\(under.domain) \(under.code))"
  }
  return text
}
