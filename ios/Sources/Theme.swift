import SwiftUI
import UIKit

/// Minimal visual language (Apple HIG): mostly system colors, restrained accent. Urgency is the
/// only thing that earns color — overdue is red, today is orange, everything else is neutral.
enum Theme {
    static let secondary = Color(uiColor: .secondaryLabel)

    /// Surface for the terminal-style engineering views. Near-black in dark (reads like a console),
    /// a calm near-white neutral in light — follows the system theme rather than fighting it.
    static let terminalBG = Color(uiColor: UIColor { trait in
        trait.userInterfaceStyle == .dark
            ? UIColor(white: 0.05, alpha: 1.0)
            : UIColor.systemBackground
    })

    /// Accent for section labels (`# focus`, `# tasks`…) — a calm teal/cyan that reads as a
    /// "prompt" color and clearly separates headers from neutral row text, in light + dark.
    static let headerAccent = Color(uiColor: UIColor { trait in
        trait.userInterfaceStyle == .dark
            ? UIColor(red: 0.40, green: 0.78, blue: 0.74, alpha: 1.0)
            : UIColor(red: 0.10, green: 0.51, blue: 0.49, alpha: 1.0)
    })

    // MARK: terminal syntax palette
    // A restrained, terminal-like set so different kinds of information read distinctly: headings
    // pop, inline code is warm, bold emphasis is calm-green. Tuned for legibility in light + dark.

    /// Markdown / section headings — a lavender-blue that stands above body text.
    static let mdHeading = Color(uiColor: UIColor { t in
        t.userInterfaceStyle == .dark
            ? UIColor(red: 0.62, green: 0.70, blue: 1.00, alpha: 1.0)
            : UIColor(red: 0.28, green: 0.33, blue: 0.78, alpha: 1.0)
    })

    /// Inline / fenced code — a warm amber, the classic terminal string/identifier color.
    static let mdCode = Color(uiColor: UIColor { t in
        t.userInterfaceStyle == .dark
            ? UIColor(red: 0.92, green: 0.74, blue: 0.42, alpha: 1.0)
            : UIColor(red: 0.62, green: 0.42, blue: 0.10, alpha: 1.0)
    })

    /// Bold emphasis in body text — a calm green, brighter than primary but not loud.
    static let mdStrong = Color(uiColor: UIColor { t in
        t.userInterfaceStyle == .dark
            ? UIColor(red: 0.62, green: 0.86, blue: 0.66, alpha: 1.0)
            : UIColor(red: 0.10, green: 0.42, blue: 0.22, alpha: 1.0)
    })

    enum Bucket: String, CaseIterable {
        case overdue, today, upcoming, noDate, awaiting

        var title: String {
            switch self {
            case .overdue: "Overdue"
            case .today: "Today"
            case .upcoming: "Upcoming"
            case .noDate: "No date"
            case .awaiting: "Waiting on others"
            }
        }

        /// One-line clarification shown under the header (nil = no subtitle).
        var subtitle: String? {
            switch self {
            case .awaiting: "Things others owe you"
            default: nil
            }
        }
    }

    /// Urgency level for the leading accent — lets you scan a vertical band of color down the list.
    enum Urgency { case overdue, today, soon, later, none }

    static func urgency(_ dueDate: String?) -> Urgency {
        guard let dueDate, let date = isoDay(dueDate) else { return .none }
        let cal = Calendar.current
        let days = cal.dateComponents([.day], from: cal.startOfDay(for: Date()), to: cal.startOfDay(for: date)).day ?? 0
        switch days {
        case ..<0: return .overdue
        case 0: return .today
        case 1...6: return .soon
        default: return .later
        }
    }

    /// Accent color for the leading bar — clear for non-urgent so the band only lights up when it matters.
    static func accent(_ u: Urgency) -> Color {
        switch u {
        case .overdue: return .red
        case .today: return .orange
        case .soon: return .blue
        case .later, .none: return .clear
        }
    }

    static func kindIcon(_ kind: String) -> String {
        switch kind {
        case "commitment": "hand.raised"
        case "request": "questionmark.bubble"
        case "action_item": "checklist"
        default: "circle"
        }
    }

    static func kindLabel(_ kind: String) -> String {
        switch kind {
        case "commitment": "Commitment"
        case "request": "Request"
        case "action_item": "Action item"
        default: "Loop"
        }
    }

    static func channelIcon(_ channel: String) -> String {
        switch channel {
        case "slack": "number.square.fill"
        case "gmail": "envelope.fill"
        case "jira": "ticket.fill"
        case "github": "chevron.left.forwardslash.chevron.right"
        default: "bubble.left.fill"
        }
    }

    /// Channel tint, lightened in dark mode so the aubergine/red stay legible on dark backgrounds.
    static func channelTint(_ channel: String, scheme: ColorScheme = .light) -> Color {
        let dark = scheme == .dark
        switch channel {
        case "slack": return dark ? Color(red: 0.72, green: 0.48, blue: 0.80) : Color(red: 0.42, green: 0.15, blue: 0.49)
        case "gmail": return dark ? Color(red: 0.96, green: 0.47, blue: 0.42) : Color(red: 0.91, green: 0.26, blue: 0.21)
        case "jira": return dark ? Color(red: 0.40, green: 0.62, blue: 0.98) : Color(red: 0.16, green: 0.40, blue: 0.85)
        case "github": return dark ? Color(white: 0.85) : Color(white: 0.20)
        default: return secondary
        }
    }

    static func channelLabel(_ channel: String) -> String {
        switch channel {
        case "slack": "Slack"
        case "gmail": "Gmail"
        case "jira": "Jira"
        case "github": "GitHub"
        default: channel.capitalized
        }
    }

    /// Relative due descriptor: label + color + whether it's urgent (overdue/today → badge).
    static func due(_ dueDate: String?) -> (label: String, color: Color, urgent: Bool) {
        guard let dueDate, let date = isoDay(dueDate) else { return ("No date", secondary, false) }
        let cal = Calendar.current
        let days = cal.dateComponents([.day], from: cal.startOfDay(for: Date()), to: cal.startOfDay(for: date)).day ?? 0
        switch days {
        case ..<0: return (days == -1 ? "Yesterday" : "\(-days)d overdue", .red, true)
        case 0: return ("Today", .orange, true)
        case 1: return ("Tomorrow", secondary, false)
        case 2...6: return ("in \(days) days", secondary, false)
        default: return (mediumDate(date), secondary, false)
        }
    }

    private static func isoDay(_ s: String) -> Date? {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .iso8601)
        f.dateFormat = "yyyy-MM-dd"
        f.timeZone = .current
        return f.date(from: s)
    }

    private static func mediumDate(_ d: Date) -> String {
        let f = DateFormatter()
        f.dateStyle = .medium
        return f.string(from: d)
    }
}

/// Light wrappers around UIKit feedback generators so action handlers can confirm a tap by touch.
@MainActor
enum Haptics {
    static func success() { UINotificationFeedbackGenerator().notificationOccurred(.success) }
    static func warning() { UINotificationFeedbackGenerator().notificationOccurred(.warning) }
    static func tap() { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
}
