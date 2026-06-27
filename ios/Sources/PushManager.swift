import UIKit
import UserNotifications

/// Posted after a notification action mutates a loop (Done/Snooze from the lock screen) so the
/// list can refresh itself.
extension Notification.Name {
    static let loopkeeperDidMutate = Notification.Name("loopkeeper.didMutate")
    /// Posted when an engineering-task push is tapped, so Home can open that task's workspace (FR-25).
    static let loopkeeperOpenTask = Notification.Name("loopkeeper.openTask")
}

/// Requests notification permission and registers for remote (APNs) notifications. The token
/// is forwarded to the backend by `AppDelegate`.
@MainActor
enum PushManager {
    static func requestAndRegister() {
        Task {
            let center = UNUserNotificationCenter.current()
            let granted = (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
            if granted {
                UIApplication.shared.registerForRemoteNotifications()
            }
        }
    }
}

/// Bridges UIKit's notification callbacks into SwiftUI: posts the APNs device token to `/devices`,
/// registers the actionable nudge category, and performs Done/Snooze actions tapped on a nudge.
@MainActor
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        LocalNudges.registerCategories()
        return true
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        Task { try? await APIClient().registerDevice(token) }
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        // Expected on the Simulator and without a push entitlement; ignore in the skeleton.
    }

    // MARK: UNUserNotificationCenterDelegate

    /// Show banners + play sound even when the app is in the foreground.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }

    /// Done / Snooze tapped on a nudge → call the backend, then signal the UI to refresh.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let info = response.notification.request.content.userInfo
        let loopId = info["loopId"] as? String
        let taskId = info["taskId"] as? String
        let action = response.actionIdentifier
        if let loopId {
            // Detach the network work so we capture only Sendable strings (Swift 6 concurrency-safe).
            Task.detached { await AppDelegate.perform(action: action, loopId: loopId) }
        } else if let taskId {
            // Engineering-task push → open its workspace on Home.
            Task { @MainActor in NotificationCenter.default.post(name: .loopkeeperOpenTask, object: nil, userInfo: ["taskId": taskId]) }
        }
        completionHandler()
    }

    nonisolated private static func perform(action: String, loopId: String) async {
        let api = APIClient()
        do {
            switch action {
            case LocalNudges.doneAction:
                try await api.markDone(loopId)
            case LocalNudges.snoozeAction:
                let until = ISO8601DateFormatter().string(from: Date().addingTimeInterval(86_400))
                try await api.snooze(loopId, untilISO: until)
            default:
                break // default tap just opens the app
            }
        } catch {
            // best-effort; the next refresh reconciles state
        }
        await MainActor.run { NotificationCenter.default.post(name: .loopkeeperDidMutate, object: nil) }
    }
}
