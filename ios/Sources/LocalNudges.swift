import Foundation
import UserNotifications

/// On-device reminders — works on a free Apple ID (no APNs / paid program). The app reschedules
/// these whenever the brief refreshes; one nudge per loop per day at 9am, never on every open.
/// Notifications carry Done / Snooze actions so loops can be triaged from the lock screen.
enum LocalNudges {
    static let categoryId = "LOOP_NUDGE"
    static let doneAction = "LOOP_DONE"
    static let snoozeAction = "LOOP_SNOOZE_1D"
    static let reviewId = "morning-review"

    static let nudgeWaitingKey = "loopkeeper.nudgeWaiting"
    static let morningReviewKey = "loopkeeper.morningReview"

    @discardableResult
    static func requestAuthorization() async -> Bool {
        (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])) ?? false
    }

    /// Register the actionable category (Done / Snooze) — call once at launch.
    static func registerCategories() {
        let done = UNNotificationAction(identifier: doneAction, title: "Mark done", options: [.authenticationRequired])
        let snooze = UNNotificationAction(identifier: snoozeAction, title: "Snooze 1 day", options: [])
        let category = UNNotificationCategory(identifier: categoryId, actions: [done, snooze], intentIdentifiers: [], options: [])
        UNUserNotificationCenter.current().setNotificationCategories([category])
    }

    /// A settings flag that defaults to ON when unset.
    private static func flag(_ key: String) -> Bool {
        UserDefaults.standard.object(forKey: key) as? Bool ?? true
    }

    /// Reschedule at-risk reminders. Idempotent (runs only after a successful refresh, so an
    /// offline refresh never clears nudges). owe-loops due overdue/today/tomorrow always; overdue
    /// or due-today "waiting on" loops too (toggle); plus an optional 9am morning summary (toggle).
    static func reschedule(_ brief: Brief) {
        let center = UNUserNotificationCenter.current()
        center.removeAllPendingNotificationRequests()

        let owe = (brief.overdue + brief.today + brief.upcoming.filter { isTomorrow($0.dueDate) }).filter { $0.direction == "owe" }
        for loop in owe { schedule(loop, on: center) }

        if flag(nudgeWaitingKey) {
            let waiting = (brief.overdue + brief.today + brief.awaiting).filter { $0.isOwed && isOverdueOrToday($0.dueDate) }
            for loop in waiting { schedule(loop, on: center) }
        }

        if flag(morningReviewKey) { scheduleMorningReview(brief, on: center) }
    }

    private static func schedule(_ loop: OpenLoop, on center: UNUserNotificationCenter) {
        let content = UNMutableNotificationContent()
        let message = message(for: loop)
        content.title = message.title
        content.body = message.body
        content.sound = .default
        content.categoryIdentifier = categoryId
        content.userInfo = ["loopId": loop.id, "direction": loop.direction]
        center.add(UNNotificationRequest(identifier: loop.id, content: content, trigger: trigger(for: loop.dueDate)))
    }

    /// Natural-language title + body per direction/urgency.
    private static func message(for loop: OpenLoop) -> (title: String, body: String) {
        if loop.isOwed {
            return ("Follow up with \(cleanName(loop.counterpart))", loop.summary)
        }
        let title: String
        switch Theme.urgency(loop.dueDate) {
        case .overdue: title = "Overdue"
        case .today: title = "Due today"
        case .soon: title = "Due \(Theme.due(loop.dueDate).label.lowercased())"
        default: title = "Reminder"
        }
        return (title, loop.summary)
    }

    private static func scheduleMorningReview(_ brief: Brief, on center: UNUserNotificationCenter) {
        let overdue = brief.overdue.count, today = brief.today.count, waiting = brief.awaiting.count
        guard overdue + today + waiting > 0 else { return }
        var bits: [String] = []
        if overdue > 0 { bits.append("\(overdue) overdue") }
        if today > 0 { bits.append("\(today) due today") }
        if waiting > 0 { bits.append("\(waiting) waiting on others") }
        let content = UNMutableNotificationContent()
        content.title = "Your loops today"
        content.body = bits.joined(separator: " · ")
        content.sound = .default
        var comps = DateComponents()
        comps.hour = 9
        comps.minute = 0
        center.add(UNNotificationRequest(identifier: reviewId, content: content, trigger: UNCalendarNotificationTrigger(dateMatching: comps, repeats: true)))
    }

    /// 9am on the due day; if that's already passed (overdue / late today), 9am tomorrow.
    private static func trigger(for dueDate: String?) -> UNNotificationTrigger {
        let cal = Calendar.current
        let today = cal.startOfDay(for: Date())
        let target = max(day(dueDate) ?? today, today)
        var comps = cal.dateComponents([.year, .month, .day], from: target)
        comps.hour = 9
        comps.minute = 0
        var fire = cal.date(from: comps) ?? Date().addingTimeInterval(3600)
        if fire <= Date() { fire = cal.date(byAdding: .day, value: 1, to: fire) ?? fire }
        return UNCalendarNotificationTrigger(
            dateMatching: cal.dateComponents([.year, .month, .day, .hour, .minute], from: fire),
            repeats: false
        )
    }

    private static func cleanName(_ s: String) -> String {
        let raw = s.trimmingCharacters(in: .whitespaces)
        if raw.isEmpty || raw.lowercased() == "unknown" || raw.hasPrefix("@") || raw.hasPrefix("<") { return "someone" }
        return raw
    }

    private static func isOverdueOrToday(_ dueDate: String?) -> Bool {
        switch Theme.urgency(dueDate) {
        case .overdue, .today: return true
        default: return false
        }
    }

    private static func isTomorrow(_ dueDate: String?) -> Bool {
        guard let date = day(dueDate) else { return false }
        return Calendar.current.isDateInTomorrow(date)
    }

    private static func day(_ s: String?) -> Date? {
        guard let s else { return nil }
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .iso8601)
        f.dateFormat = "yyyy-MM-dd"
        f.timeZone = .current
        return f.date(from: s)
    }
}
