import ExpoModulesCore
import MediaPlayer

/**
 Now Playing and the system's remote commands, for `src/media-controls.ts`: the lock screen,
 Control Center, headphones and a car show what the app's one player plays, and each command
 they send comes back as a `command` event. JavaScript answers it as Watch's own buttons do;
 nothing here plays, pauses or moves the player. `clear` takes both away.
 */
public class MediaControlsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("MediaControls")

    Events("command")

    OnCreate {
      let owner = ObjectIdentifier(self)
      DispatchQueue.main.async {
        MediaControlsRelay.shared.owner = owner
        MediaControlsRelay.shared.send = { [weak self] body in self?.sendEvent("command", body) }
      }
    }

    // A reload's new module may have taken the relay over first; only its own owner clears it.
    OnDestroy {
      let owner = ObjectIdentifier(self)
      DispatchQueue.main.async {
        guard MediaControlsRelay.shared.owner == owner else { return }
        MediaControlsRelay.shared.owner = nil
        MediaControlsRelay.shared.send = nil
        MediaControlsRelay.shared.show(nil)
      }
    }

    Function("set") { (info: NowPlaying) in
      let shown = Shown(
        title: info.title,
        subtitle: info.subtitle,
        live: info.live,
        duration: info.duration,
        elapsed: info.elapsed,
        rate: info.rate,
        speed: info.speed,
        seekable: info.seekable,
        next: info.next
      )
      DispatchQueue.main.async { MediaControlsRelay.shared.show(shown) }
    }

    Function("clear") {
      DispatchQueue.main.async { MediaControlsRelay.shared.show(nil) }
    }
  }
}

struct NowPlaying: Record {
  @Field var title: String = ""
  @Field var subtitle: String = ""
  @Field var live: Bool = false
  @Field var duration: Double? = nil
  @Field var elapsed: Double = 0
  @Field var rate: Double = 0
  @Field var speed: Double = 1
  @Field var seekable: Bool = false
  @Field var next: Bool = false
}

/** What shows, copied off the JavaScript thread. */
struct Shown {
  let title: String
  let subtitle: String
  let live: Bool
  let duration: Double?
  let elapsed: Double
  let rate: Double
  let speed: Double
  let seekable: Bool
  let next: Bool

  /** iOS counts the elapsed time on from here at `rate`; a channel has neither. */
  var info: [String: Any] {
    var values: [String: Any] = [
      MPMediaItemPropertyTitle: title,
      MPMediaItemPropertyArtist: subtitle,
      // The raw value: the enum itself crashes, as expo-video found.
      MPNowPlayingInfoPropertyMediaType: NSNumber(value: MPNowPlayingInfoMediaType.video.rawValue),
      MPNowPlayingInfoPropertyIsLiveStream: live,
      MPNowPlayingInfoPropertyPlaybackRate: rate,
      MPNowPlayingInfoPropertyDefaultPlaybackRate: speed,
    ]
    if !live {
      values[MPNowPlayingInfoPropertyElapsedPlaybackTime] = elapsed
      if let duration { values[MPMediaItemPropertyPlaybackDuration] = duration }
    }
    return values
  }
}

/** The commands answered while something shows: play and pause always, the rest as it allows. */
struct Commands: Equatable {
  let seekable: Bool
  let next: Bool
}

/** The process's one Now Playing and its command targets, on the main thread. */
final class MediaControlsRelay {
  static let shared = MediaControlsRelay()

  var owner: ObjectIdentifier?
  var send: (([String: Any]) -> Void)?
  private var answering: Commands?
  private var targets: [(command: MPRemoteCommand, target: Any)] = []

  /** Shows `shown`, or nothing for nil, with only the commands it answers. */
  func show(_ shown: Shown?) {
    answer(shown.map { Commands(seekable: $0.seekable, next: $0.next) })
    MPNowPlayingInfoCenter.default().nowPlayingInfo = shown?.info
  }

  private func answer(_ commands: Commands?) {
    guard commands != answering else { return }
    answering = commands
    for (command, target) in targets {
      command.removeTarget(target)
      command.isEnabled = false
    }
    targets = []
    guard let commands else { return }
    let center = MPRemoteCommandCenter.shared()
    add(center.playCommand) { _ in ["command": "play"] }
    add(center.pauseCommand) { _ in ["command": "pause"] }
    add(center.togglePlayPauseCommand) { _ in ["command": "toggle"] }
    if commands.seekable {
      center.skipForwardCommand.preferredIntervals = [10]
      center.skipBackwardCommand.preferredIntervals = [10]
      add(center.skipForwardCommand) { event in
        ["command": "skip", "seconds": (event as? MPSkipIntervalCommandEvent)?.interval ?? 10]
      }
      add(center.skipBackwardCommand) { event in
        ["command": "skip", "seconds": -((event as? MPSkipIntervalCommandEvent)?.interval ?? 10)]
      }
      add(center.changePlaybackPositionCommand) { event in
        guard let event = event as? MPChangePlaybackPositionCommandEvent else { return nil }
        return ["command": "seek", "position": event.positionTime]
      }
    }
    if commands.next {
      add(center.nextTrackCommand) { _ in ["command": "next"] }
    }
  }

  private func add(
    _ command: MPRemoteCommand,
    _ body: @escaping (MPRemoteCommandEvent) -> [String: Any]?
  ) {
    let target = command.addTarget { [weak self] event in
      guard let send = self?.send, let values = body(event) else { return .commandFailed }
      send(values)
      return .success
    }
    command.isEnabled = true
    targets.append((command, target))
  }
}
