import Foundation
import SwiftUI

/// Mirrors the backend `OpenLoop` JSON (camelCase keys match 1:1, so no CodingKeys needed).
struct OpenLoop: Codable, Identifiable, Hashable {
    let id: String
    let direction: String      // "owe" | "owed"
    let kind: String           // "commitment" | "request" | "action_item"
    let summary: String
    let counterpart: String
    let channel: String        // "slack" | "gmail"
    let permalink: String
    let sourceLabel: String?    // e.g. "#baylor-ns-internal-all", "DM"; nil for email
    let dueDate: String?        // YYYY-MM-DD or null
    let dueConfidence: String   // "explicit" | "inferred" | "none"
    let firmness: String        // "firm" | "tentative"
    let status: String
    let tenant: String
    // Returned by the API; previously dropped at decode. All optional / additive.
    let snoozedUntil: String?   // ISO instant; future = currently snoozed
    let resolution: String?     // "replied" | "sent" | "jira_transition" | "manual"
    let createdTs: String?      // ISO instant when first captured
    let resolvedTs: String?     // ISO instant when closed
    let userLabel: String?      // "true" | "false" precision feedback
    let quoteExcerpt: String?   // verbatim source snippet (opt-in on the backend; usually nil)
    let recurrence: String?     // "daily" | "weekly" | "monthly" | nil
    let snoozeCondition: String? // "reply" when snoozed until they reply
    let project: String?
    let tags: [String]?

    var isFirm: Bool { firmness == "firm" }
    var isOwed: Bool { direction == "owed" }
    var isInferredDate: Bool { dueConfidence == "inferred" }
    var dueLabel: String { dueDate ?? "no date" }

    var isSnoozed: Bool {
        guard let snoozedUntil, let d = ISO8601DateFormatter().date(from: snoozedUntil) else { return false }
        return d > Date()
    }
}

/// The daily brief from `GET /brief`.
struct Brief: Codable {
    let date: String
    let overdue: [OpenLoop]
    let today: [OpenLoop]
    let upcoming: [OpenLoop]
    let noDate: [OpenLoop]
    let awaiting: [OpenLoop]
}

/// `GET /scan/status` — the background scan's state.
struct ScanStatus: Codable {
    let running: Bool
    let lastError: String?
    let last: ScanSummary?
}

/// The most recent finished scan's result (subset of the backend `ScanResult`).
struct ScanSummary: Codable {
    let fetched: Int?
    let extracted: Int?
    let inserted: Int?
    /// Coverage warnings (e.g. Free-plan search unavailable, channel truncation).
    let warnings: [String]?
}

/// A connected account from `/healthz`.
struct Connection: Codable, Hashable {
    let provider: String
    let account: String
}

/// `GET /healthz`.
struct Health: Codable {
    let ok: Bool
    let loops: Int
    let connected: [Connection]
    let extraction: String

    var extractionConfigured: Bool { extraction.hasPrefix("configured") }
}

/// A pickable Slack channel from `GET /channels`.
struct SlackChannelDTO: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let kind: String
    let enabled: Bool
}

/// `GET /channels`.
struct ChannelsResponse: Codable {
    let slack: [SlackChannelDTO]
    let slackError: String?
    let slackScope: String
    let gmailQuery: String
}

/// `GET /stats` — reliability / throughput / ROI metrics.
struct Stats: Codable {
    struct OpenCounts: Codable { let total: Int; let owe: Int; let owed: Int; let overdue: Int }
    struct ClosedCounts: Codable { let total: Int; let last7: Int; let last30: Int }
    struct DismissedCounts: Codable { let total: Int }
    struct WeekCount: Codable, Identifiable { let week: String; let closed: Int; var id: String { week } }
    let open: OpenCounts
    let closed: ClosedCounts
    let dismissed: DismissedCounts
    let onTimeRate: Double?
    let medianTimeToCloseHours: Double?
    let carryOver: Int
    let onTimeStreak: Int
    let byWeek: [WeekCount]
}

/// Body for `PUT /config`.
struct ConfigUpdate: Encodable {
    let slackScope: String
    let slackChannelIds: [String]
    let gmailQuery: String
}

extension OpenLoop {
    var isOwe: Bool { direction == "owe" }

    /// Deterministic 0–100 triage score: urgency (due date + confidence) + importance
    /// (firmness, kind, direction). Lets the list rank beyond raw due-date order.
    var priorityScore: Int {
        var score: Int
        switch Theme.urgency(dueDate) {
        case .overdue: score = 50
        case .today: score = 40
        case .soon: score = 24
        case .later: score = 10
        case .none: score = 8
        }
        if dueConfidence == "inferred" { score = Int(Double(score) * 0.85) }
        score += isFirm ? 20 : 8
        switch kind {
        case "action_item", "request": score += 6
        case "commitment": score += 3
        default: break
        }
        score += isOwe ? 10 : 4
        return min(score, 100)
    }

    /// A `slack://` deep link that opens the native Slack app at the message, derived when the
    /// stored permalink is the web-client form (`app.slack.com/client/{team}/{channel}/{tsDigits}`)
    /// — which iOS would otherwise open in Safari. Returns nil for `/archives` Universal Links and
    /// Gmail URLs, which already open in the right app on their own.
    var slackDeepLink: URL? {
        guard channel == "slack",
              let comps = URLComponents(string: permalink),
              comps.host == "app.slack.com" else { return nil }
        let parts = comps.path.split(separator: "/").map(String.init)
        guard parts.count >= 4, parts[0] == "client" else { return nil }
        var link = URLComponents()
        link.scheme = "slack"
        link.host = "channel"
        link.queryItems = [
            URLQueryItem(name: "team", value: parts[1]),
            URLQueryItem(name: "id", value: parts[2]),
            URLQueryItem(name: "message", value: Self.restoreTimestamp(parts[3])),
        ]
        return link.url
    }

    var sourceWebURL: URL? { URL(string: permalink) }

    /// "1750000100000000" → "1750000100.000000" (Slack timestamps carry 6 microsecond digits).
    private static func restoreTimestamp(_ digits: String) -> String {
        let d = digits.hasPrefix("p") ? String(digits.dropFirst()) : digits
        guard d.count > 6, d.allSatisfy(\.isNumber) else { return d }
        let cut = d.index(d.endIndex, offsetBy: -6)
        return "\(d[..<cut]).\(d[cut...])"
    }
}

/// Open a loop's source: prefer the Slack app deep link; fall back to the web permalink (a browser,
/// or a Universal Link that hands off to the app) when the app can't handle the deep link.
@MainActor
func openLoopSource(_ loop: OpenLoop, using openURL: OpenURLAction) {
    if let deep = loop.slackDeepLink {
        openURL(deep) { accepted in
            if !accepted, let web = loop.sourceWebURL { openURL(web) }
        }
    } else if let web = loop.sourceWebURL {
        openURL(web)
    }
}
