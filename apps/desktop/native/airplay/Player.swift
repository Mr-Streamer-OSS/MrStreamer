// The one AVPlayer. It holds nothing, the placeholder, or one load of the app's media. Nothing of
// the app's ever shows or sounds on this computer: the helper has no window to show a picture in,
// media plays only while external playback is active, and whenever it isn't, the player is muted
// as well.
import AVFoundation

/// Seconds the player may read ahead, so a fast local network doesn't pull in a whole movie.
private let forwardBuffer: TimeInterval = 30

/// For trying the helper where there is no receiver: MR_STREAMER_AIRPLAY_WITHOUT_RECEIVER=1 lets
/// media play without external playback. It stays muted, as always without a receiver.
private let withoutReceiver =
  ProcessInfo.processInfo.environment["MR_STREAMER_AIRPLAY_WITHOUT_RECEIVER"] == "1"

/// One load: its item, and what the app asked of it.
private final class Media {
  let generation: Int
  let item: AVPlayerItem
  var subtitles: Bool
  var legible: AVMediaSelectionGroup?
  var ended = false
  var watching: [Any] = []

  init(generation: Int, item: AVPlayerItem, subtitles: Bool) {
    self.generation = generation
    self.item = item
    self.subtitles = subtitles
  }
}

final class RoutePlayer {
  let player = AVPlayer()
  /// Whether the system's list is up: letting go of media then keeps the placeholder.
  var choosing: () -> Bool = { false }

  private var media: Media?
  private var placeholder: AVPlayerItem?
  private var placeholderWatching: [Any] = []
  private var wantsPlaying = false
  private var wantsMuted = false
  private var seeks = 0
  private var watching: [Any] = []
  private var ticker: Timer?
  private var awake: NSObjectProtocol?
  /// What was said last, so a change the player reports twice is said once.
  private var saidStatus: NSDictionary?
  private var saidVolume: NSDictionary?

  init() {
    // Subtitles show when the app says so, not by the system's caption preferences.
    player.appliesMediaSelectionCriteriaAutomatically = false
    watching = [
      player.observe(\.isExternalPlaybackActive) { [weak self] _, _ in
        onMain { self?.externalChanged() }
      },
      player.observe(\.timeControlStatus) { [weak self] _, _ in onMain { self?.report() } },
      player.observe(\.volume) { [weak self] _, _ in onMain { self?.reportVolume() } },
    ]
  }

  /// The generation of the load the player holds, for commands that name one.
  var generation: Int? { media?.generation }

  /// Has the player hold the placeholder while the viewer chooses, unless it holds media.
  func holdPlaceholder() {
    if media == nil { hold(nil, keepRoute: true) }
  }

  /// Replaces what the player holds with a load of the app's media.
  func load(
    generation: Int, url: URL, position: Double, paused: Bool, live: Bool, subtitles: Bool
  ) {
    forget()
    let item = AVPlayerItem(url: url)
    item.preferredForwardBufferDuration = forwardBuffer
    let media = Media(generation: generation, item: item, subtitles: subtitles)
    watch(media)
    if !live && position > 0 {
      item.seek(
        to: time(position), toleranceBefore: .zero, toleranceAfter: .zero, completionHandler: nil)
    }
    wantsPlaying = !paused
    let ticker = Timer(timeInterval: 1, repeats: true) { [weak self] _ in self?.tick() }
    RunLoop.main.add(ticker, forMode: .common)
    self.ticker = ticker
    hold(media, keepRoute: true)
    readLegible(media)
  }

  func play() {
    guard let media, !media.ended else { return }
    wantsPlaying = true
    enforce()
    report()
  }

  func pause() {
    guard media != nil else { return }
    wantsPlaying = false
    enforce()
    report()
  }

  /// Moves to the exact position and keeps playing or holding as before.
  func seek(to position: Double) {
    guard let media else { return }
    media.ended = false
    seeks += 1
    player.seek(to: time(position), toleranceBefore: .zero, toleranceAfter: .zero) {
      [weak self] _ in
      onMain {
        guard let self, self.media === media else { return }
        self.seeks -= 1
        self.report()
      }
    }
  }

  func showSubtitles(_ on: Bool) {
    media?.subtitles = on
    applySubtitles()
    report()
  }

  func setVolume(level: Double?, muted: Bool?) {
    if let muted { wantsMuted = muted }
    if let level { player.volume = Float(min(max(level, 0), 1)) }
    mute()
    reportVolume()
  }

  /// Ends the load. A connected receiver stays, on the placeholder.
  func stop() {
    forget()
    hold(nil, keepRoute: player.isExternalPlaybackActive || choosing())
  }

  /// Lets go of the app's media and of the receiver's picture. While the list is up the
  /// placeholder stays, so a route chosen next still shows.
  func unload() {
    forget()
    hold(nil, keepRoute: choosing())
  }

  /// The volume as the app set it, for the receiver. The mute this computer adds isn't in it.
  func reportVolume() {
    let volume: [String: Any] = ["level": rounded(Double(player.volume)), "muted": wantsMuted]
    if volume as NSDictionary == saidVolume { return }
    saidVolume = volume as NSDictionary
    emit("volume", volume)
  }

  /// Gives the player a load, or the placeholder to keep or await a route, or nothing.
  private func hold(_ media: Media?, keepRoute: Bool) {
    self.media = media
    if media != nil || !keepRoute {
      unwatch(&placeholderWatching)
      placeholder = nil
    } else if placeholder == nil, let item = Placeholder.item() {
      placeholder = item
      watchPlaceholder(item)
    }
    let item = media?.item ?? placeholder
    // Before the item changes too, so the new one never starts at the old one's rate or mute.
    enforce()
    if player.currentItem !== item { player.replaceCurrentItem(with: item) }
    enforce()
    report()
  }

  /// Sets the rate and the mute the player may have now. The app's media plays only while
  /// external playback is active. Where the route probe plays its placeholder, media too may
  /// start before external playback shows. The placeholder has no sound.
  private func enforce() {
    let external = player.isExternalPlaybackActive
    let early = withoutReceiver || RouteProbe.chosen == .playing
    let plays =
      media != nil
      ? wantsPlaying && (external || early)
      : placeholder != nil && RouteProbe.chosen == .playing
    mute()
    if plays && player.rate == 0 { player.play() }
    if !plays && player.rate != 0 { player.pause() }
    keepAwake(plays && media != nil)
  }

  /// The app's media is muted whenever external playback isn't active, whatever its rate. This
  /// leaves the rate alone, which the receiver's own remote may have changed.
  private func mute() {
    player.isMuted = wantsMuted || (media != nil && !player.isExternalPlaybackActive)
  }

  private func externalChanged() {
    emit(
      "external",
      [
        "active": player.isExternalPlaybackActive,
        "holding": media != nil ? "media" : placeholder != nil ? "placeholder" : "nothing",
      ])
    enforce()
    report()
  }

  /// Drops the load, saying it stopped. The caller decides what the player holds next.
  private func forget() {
    if let media = drop() { emit("status", status(of: media, state: "stopped")) }
  }

  private func drop() -> Media? {
    guard let media else { return nil }
    unwatch(&media.watching)
    self.media = nil
    saidStatus = nil
    wantsPlaying = false
    seeks = 0
    ticker?.invalidate()
    ticker = nil
    return media
  }

  private func watch(_ media: Media) {
    let item = media.item
    let center = NotificationCenter.default
    media.watching = [
      item.observe(\.status) { [weak self] _, _ in
        onMain {
          guard let self, self.media === media else { return }
          if item.status == .failed { self.fail(media, item.error) } else { self.report() }
        }
      },
      center.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main) {
        [weak self] _ in
        guard let self, self.media === media else { return }
        media.ended = true
        self.wantsPlaying = false
        self.enforce()
        self.report()
      },
      center.addObserver(forName: .AVPlayerItemFailedToPlayToEndTime, object: item, queue: .main) {
        [weak self] notice in
        self?.fail(media, notice.userInfo?[AVPlayerItemFailedToPlayToEndTimeErrorKey] as? Error)
      },
      center.addObserver(forName: .AVPlayerItemPlaybackStalled, object: item, queue: .main) { _ in
        note("Playback stalled.")
      },
      center.addObserver(forName: .AVPlayerItemNewErrorLogEntry, object: item, queue: .main) { _ in
        guard let entry = item.errorLog()?.events.last else { return }
        note("\(entry.errorComment ?? "An error") (\(entry.errorDomain) \(entry.errorStatusCode))")
      },
    ]
  }

  /// Says whether the placeholder can play, since no route shows on one that can't, and starts
  /// it over when the route probe plays it.
  private func watchPlaceholder(_ item: AVPlayerItem) {
    placeholderWatching = [
      item.observe(\.status) { item, _ in
        if item.status == .readyToPlay { note("The placeholder is ready.") }
        if item.status == .failed { note("The placeholder failed: \(describe(item.error))") }
      },
      NotificationCenter.default.addObserver(
        forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main
      ) { [weak self] _ in
        item.seek(to: .zero, completionHandler: nil)
        self?.enforce()
      },
    ]
  }

  /// The item can't play. A connected receiver stays, on the placeholder.
  private func fail(_ media: Media, _ error: Error?) {
    guard self.media === media, drop() != nil else { return }
    emit("failed", ["generation": media.generation, "message": describe(error)])
    hold(nil, keepRoute: player.isExternalPlaybackActive || choosing())
  }

  /// Finds the media's text renditions, of which the playlist carries one at most, and shows it
  /// when the app asked for subtitles.
  private func readLegible(_ media: Media) {
    let asset = media.item.asset
    let key = "availableMediaCharacteristicsWithMediaSelectionOptions"
    asset.loadValuesAsynchronously(forKeys: [key]) { [weak self] in
      onMain {
        guard let self, self.media === media else { return }
        media.legible = asset.mediaSelectionGroup(forMediaCharacteristic: .legible)
        note("The media has \(media.legible?.options.count ?? 0) subtitle renditions.")
        self.applySubtitles()
        self.report()
      }
    }
  }

  private func applySubtitles() {
    guard let media, let group = media.legible else { return }
    media.item.select(media.subtitles ? group.options.first : nil, in: group)
  }

  private func tick() {
    guard let media, seeks == 0 else { return }
    let state = state(of: media)
    if state == "playing" || state == "buffering" { report() }
  }

  private func report() {
    guard let media else { return }
    let status = status(of: media, state: state(of: media))
    if status as NSDictionary == saidStatus { return }
    saidStatus = status as NSDictionary
    emit("status", status)
  }

  /// `ended` only once the item played to its end; `loading` until it is ready to play.
  private func state(of media: Media) -> String {
    if media.ended { return "ended" }
    if media.item.status != .readyToPlay { return "loading" }
    switch player.timeControlStatus {
    case .playing: return "playing"
    case .waitingToPlayAtSpecifiedRate: return "buffering"
    default: return "paused"
    }
  }

  private func status(of media: Media, state: String) -> [String: Any] {
    let item = media.item
    let duration = item.duration.isNumeric ? rounded(item.duration.seconds) : nil
    let now = item.currentTime()
    let position = now.isNumeric ? rounded(max(now.seconds, 0)) : 0
    let shown = media.legible.flatMap { item.currentMediaSelection.selectedMediaOption(in: $0) }
    return [
      "generation": media.generation,
      "state": state,
      "position": position,
      "duration": duration.map { $0 as Any } ?? NSNull(),
      "rate": Double(player.rate),
      "muted": player.isMuted,
      "external": player.isExternalPlaybackActive,
      "subtitles": shown != nil,
    ]
  }

  /// Keeps this computer from sleeping while it serves a receiver that plays.
  private func keepAwake(_ on: Bool) {
    if on, awake == nil {
      awake = ProcessInfo.processInfo.beginActivity(
        options: .userInitiated, reason: "Playing on an AirPlay receiver")
    } else if !on, let token = awake {
      ProcessInfo.processInfo.endActivity(token)
      awake = nil
    }
  }
}

private func unwatch(_ watching: inout [Any]) {
  for watched in watching {
    if let observation = watched as? NSKeyValueObservation {
      observation.invalidate()
    } else {
      NotificationCenter.default.removeObserver(watched)
    }
  }
  watching = []
}

/// To the millisecond, which is all a position or a volume needs, as a number that prints so.
private func rounded(_ value: Double) -> NSNumber {
  NSDecimalNumber(string: String(format: "%.3f", value))
}

private func time(_ seconds: Double) -> CMTime {
  CMTime(seconds: max(seconds, 0), preferredTimescale: 1000)
}

/// Runs on the main thread, now when already there: the player's changes can come from others.
func onMain(_ work: @escaping () -> Void) {
  if Thread.isMainThread { work() } else { DispatchQueue.main.async(execute: work) }
}
