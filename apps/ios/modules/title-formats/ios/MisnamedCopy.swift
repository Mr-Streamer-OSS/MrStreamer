import ExpoVideo
import Foundation

/// Opens a copy on the phone that is MP4 or MOV whatever its name says, such as an MP4 kept as
/// `media.mkv`. AVFoundation types a local file by its name and refuses that one
/// (AVFoundationErrorDomain -11828), where over HTTP the response's type decides. Playback asks
/// for this by giving the player a copy's `file:` address as `progressive`, once its session
/// answered `direct`, which it also answers for a file that is neither Matroska nor MP4. So only a
/// copy that starts as MP4 or MOV does is opened through a link to it named `.mp4`, removed with
/// the asset; any other opens under its own name and fails as it did.
final class MisnamedCopy: VideoAssetTransportProvider {
  let identifier = "app.mrstreamer.title-formats.misnamed-copy"
  let priority = 0

  /// Where the links go: emptied of those a crash or a force quit left once per process, before
  /// its first link, however often the module is made again.
  private static let links: URL = {
    let folder = FileManager.default.temporaryDirectory
      .appendingPathComponent("misnamed-copies", isDirectory: true)
    try? FileManager.default.removeItem(at: folder)
    return folder
  }()

  /// The boxes an MP4 or MOV file starts with, at bytes 4 to 8, as FFmpeg's MOV probe knows them.
  private static let firstBoxes: Set<String> = [
    "ftyp", "moov", "mdat", "wide", "ediw", "free", "junk", "skip", "pnot", "udta", "uuid", "pict",
    "prfl",
  ]

  func makeLoadPlan(for source: VideoAssetSourceDescriptor) -> VideoAssetLoadPlan? {
    guard source.url.isFileURL, source.contentTypeHint == .progressive,
      let file = try? FileHandle(forReadingFrom: source.url)
    else { return nil }
    defer { try? file.close() }
    let head = (try? file.read(upToCount: 8)) ?? Data()
    guard head.count == 8,
      let box = String(bytes: head.suffix(4), encoding: .ascii),
      Self.firstBoxes.contains(box)
    else { return nil }
    let link = Self.links.appendingPathComponent("\(UUID().uuidString).mp4")
    do {
      try FileManager.default.createDirectory(at: Self.links, withIntermediateDirectories: true)
      try FileManager.default.createSymbolicLink(at: link, withDestinationURL: source.url)
    } catch {
      return nil
    }
    return VideoAssetLoadPlan(
      assetURL: link,
      onAssetDeinit: { try? FileManager.default.removeItem(at: link) })
  }
}
