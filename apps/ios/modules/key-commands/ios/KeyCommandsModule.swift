import ExpoModulesCore
import UIKit

/**
 The app's keyboard shortcuts, for `src/key-commands.ts`: system key commands on the key window's
 root view controller, which iOS lists while ⌘ is held, each reported back as a `command` event
 with its id. JavaScript replaces the whole set as Watch opens and closes.
 */
public class KeyCommandsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("KeyCommands")

    Events("command")

    OnCreate {
      DispatchQueue.main.async {
        KeyCommandRelay.shared.send = { [weak self] id in self?.sendEvent("command", ["id": id]) }
      }
    }

    OnDestroy {
      KeyCommandRelay.shared.send = nil
      DispatchQueue.main.async { KeyCommandRelay.shared.set([]) }
    }

    Function("set") { (shortcuts: [Shortcut]) in
      let wanted = shortcuts.map { ($0.id, $0.input, $0.command, $0.title) }
      DispatchQueue.main.async { KeyCommandRelay.shared.set(wanted) }
    }
  }
}

struct Shortcut: Record {
  @Field var id: String = ""
  @Field var input: String = ""
  @Field var command: Bool = false
  @Field var title: String = ""
}

/**
 The installed commands, on the main thread. They go on the key window's root view controller,
 which every screen's responders lead to, and move to a new one when another window becomes key.
 */
final class KeyCommandRelay {
  static let shared = KeyCommandRelay()

  var send: ((String) -> Void)?
  private var wanted: [(id: String, input: String, command: Bool, title: String)] = []
  private var installed: [UIKeyCommand] = []
  private weak var host: UIViewController?

  private init() {
    NotificationCenter.default.addObserver(
      forName: UIWindow.didBecomeKeyNotification, object: nil, queue: .main
    ) { [weak self] _ in self?.install() }
  }

  func set(_ shortcuts: [(id: String, input: String, command: Bool, title: String)]) {
    wanted = shortcuts
    install()
  }

  private func install() {
    for command in installed { host?.removeKeyCommand(command) }
    installed = []
    let window = UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap(\.windows)
      .first(where: \.isKeyWindow)
    guard let root = window?.rootViewController else { return }
    host = root
    installed = wanted.map { shortcut in
      let command = UIKeyCommand(
        title: shortcut.title,
        action: #selector(UIViewController.mrStreamerKeyCommand(_:)),
        input: Self.key(shortcut.input),
        modifierFlags: shortcut.command ? .command : [],
        propertyList: shortcut.id
      )
      // Space and the arrows reach Watch before the system's keyboard focus moves with them.
      command.wantsPriorityOverSystemBehavior = true
      return command
    }
    for command in installed { root.addKeyCommand(command) }
  }

  private static func key(_ name: String) -> String {
    switch name {
    case "leftArrow": return UIKeyCommand.inputLeftArrow
    case "rightArrow": return UIKeyCommand.inputRightArrow
    case "escape": return UIKeyCommand.inputEscape
    default: return name
    }
  }
}

extension UIViewController {
  /** Where every shortcut's key command lands, whichever view controller answers it first. */
  @objc func mrStreamerKeyCommand(_ sender: UIKeyCommand) {
    guard let id = sender.propertyList as? String else { return }
    KeyCommandRelay.shared.send?(id)
  }
}
