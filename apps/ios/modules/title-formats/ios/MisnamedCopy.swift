import ExpoVideo
import Foundation

/// Opens a copy on the phone that is MP4 or MOV whatever its name says, such as an MP4 kept as
/// `media.mkv`. AVFoundation types a local file by its name and refuses that one
/// (AVFoundationErrorDomain -11828), where over HTTP the response's type decides. Playback asks
/// for this by giving the player a copy's `file:` address as `progressive`, once its session
/// answered `direct`. The player then opens a link to the copy named `.mp4`, which AVFoundation
/// reads as MP4 or MOV, and still refuses when the file is neither; the link goes with the asset.
final class MisnamedCopy: VideoAssetTransportProvider {
  let identifier = "app.mrstreamer.title-formats.misnamed-copy"
  let priority = 0

  func makeLoadPlan(for source: VideoAssetSourceDescriptor) -> VideoAssetLoadPlan? {
    guard source.url.isFileURL, source.contentTypeHint == .progressive else { return nil }
    let link = FileManager.default.temporaryDirectory
      .appendingPathComponent("copy-\(UUID().uuidString).mp4")
    do {
      try FileManager.default.createSymbolicLink(at: link, withDestinationURL: source.url)
    } catch {
      // The copy's own address, which fails as it would have.
      return nil
    }
    return VideoAssetLoadPlan(
      assetURL: link,
      onAssetDeinit: { try? FileManager.default.removeItem(at: link) })
  }
}
