import ExpoModulesCore
import UIKit
import UserNotifications

/// Every identifier the app schedules starts with this, so only its own reminders are read or taken down.
private let prefix = "reminder."

/**
 Programme reminders for `src/reminders.ts`: local notifications iOS shows at a programme's start,
 scheduled ahead, so nothing of the app needs to run then. Each carries its channel and start, and a
 tap is held for JavaScript (`takeOpened`) and announced with an `opened` event, also the tap that
 launched the app before JavaScript ran. Shown in the foreground too, as a banner.
 */
public class ProgrammeRemindersModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ProgrammeReminders")

    Events("opened")

    OnCreate {
      let owner = ObjectIdentifier(self)
      ReminderRelay.shared.listen(owner) { [weak self] in self?.sendEvent("opened", [:]) }
    }

    // A reload's new module may have taken the relay over first; only its own owner clears it.
    OnDestroy {
      ReminderRelay.shared.stop(ObjectIdentifier(self))
    }

    AsyncFunction("permission") { (promise: Promise) in
      UNUserNotificationCenter.current().getNotificationSettings { settings in
        promise.resolve(permission(settings.authorizationStatus))
      }
    }

    AsyncFunction("ask") { (promise: Promise) in
      let center = UNUserNotificationCenter.current()
      center.requestAuthorization(options: [.alert, .sound]) { _, _ in
        center.getNotificationSettings { settings in
          promise.resolve(permission(settings.authorizationStatus))
        }
      }
    }

    AsyncFunction("scheduled") { (promise: Promise) in
      UNUserNotificationCenter.current().getPendingNotificationRequests { requests in
        promise.resolve(requests.compactMap { request -> [String: Any]? in
          guard request.identifier.hasPrefix(prefix),
            let channel = request.content.userInfo["channel"] as? String,
            let at = request.content.userInfo["at"] as? Double
          else { return nil }
          return [
            "id": String(request.identifier.dropFirst(prefix.count)),
            "at": at,
            "title": request.content.title,
            "body": request.content.body,
            "channel": channel,
          ]
        })
      }
    }

    AsyncFunction("schedule") { (notices: [Notice], promise: Promise) in
      let center = UNUserNotificationCenter.current()
      let group = DispatchGroup()
      for notice in notices {
        // An absolute instant: neither the time zone nor daylight saving moves it.
        let seconds = notice.at / 1000 - Date().timeIntervalSince1970
        guard seconds >= 1 else { continue }
        let content = UNMutableNotificationContent()
        content.title = notice.title
        content.body = notice.body
        content.sound = .default
        content.threadIdentifier = "reminders"
        content.userInfo = ["channel": notice.channel, "at": notice.at]
        let request = UNNotificationRequest(
          identifier: prefix + notice.id,
          content: content,
          trigger: UNTimeIntervalNotificationTrigger(timeInterval: seconds, repeats: false)
        )
        group.enter()
        // One iOS refuses is left out: the next check schedules it again.
        center.add(request) { _ in group.leave() }
      }
      group.notify(queue: .main) { promise.resolve(nil) }
    }

    AsyncFunction("cancel") { (ids: [String]) in
      let identifiers = ids.map { prefix + $0 }
      let center = UNUserNotificationCenter.current()
      center.removePendingNotificationRequests(withIdentifiers: identifiers)
      center.removeDeliveredNotifications(withIdentifiers: identifiers)
    }

    Function("takeOpened") { () -> [String: Any]? in
      ReminderRelay.shared.take()
    }
  }
}

struct Notice: Record {
  @Field var id: String = ""
  @Field var at: Double = 0
  @Field var title: String = ""
  @Field var body: String = ""
  @Field var channel: String = ""
}

private func permission(_ status: UNAuthorizationStatus) -> String {
  switch status {
  case .notDetermined: return "undetermined"
  case .denied: return "denied"
  default: return "granted"
  }
}

/**
 The notification centre's delegate, set as the app launches, before iOS hands it the tap that
 launched it. It holds the last tap of a reminder until JavaScript takes it.
 */
final class ReminderRelay: NSObject, UNUserNotificationCenterDelegate {
  static let shared = ReminderRelay()

  private let lock = NSLock()
  private var opened: [String: Any]?
  private var owner: ObjectIdentifier?
  private var announce: (() -> Void)?

  func listen(_ owner: ObjectIdentifier, _ announce: @escaping () -> Void) {
    lock.lock()
    self.owner = owner
    self.announce = announce
    lock.unlock()
  }

  func stop(_ owner: ObjectIdentifier) {
    lock.lock()
    if self.owner == owner {
      self.owner = nil
      announce = nil
    }
    lock.unlock()
  }

  func take() -> [String: Any]? {
    lock.lock()
    defer { lock.unlock() }
    let taken = opened
    opened = nil
    return taken
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    let ours = notification.request.identifier.hasPrefix(prefix)
    completionHandler(ours ? [.banner, .list, .sound] : [])
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    let content = response.notification.request.content
    if response.notification.request.identifier.hasPrefix(prefix),
      response.actionIdentifier == UNNotificationDefaultActionIdentifier,
      let channel = content.userInfo["channel"] as? String,
      let at = content.userInfo["at"] as? Double
    {
      lock.lock()
      opened = ["channel": channel, "at": at]
      let announce = self.announce
      lock.unlock()
      announce?()
    }
    completionHandler()
  }
}

/// Makes the relay the notification centre's delegate before the app finishes launching.
public class ProgrammeRemindersLaunch: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    UNUserNotificationCenter.current().delegate = ReminderRelay.shared
    return true
  }
}
