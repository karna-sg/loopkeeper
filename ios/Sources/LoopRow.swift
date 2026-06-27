import SwiftUI

/// A loop row, terminal-clean: one dense monospaced line —
///
///     ● today  Ship the retry queue patch
///       you owe Priya · #team
///
/// A leading glyph carries urgency (`·` not urgent, `●` today, `!` overdue). The due token is plain
/// monospaced text, never a capsule. Direction + source sit on a second dim line. No leading color
/// bar, no kind icon, no card chrome — hierarchy comes from weight + indent.
struct LoopRow: View {
    let loop: OpenLoop

    var body: some View {
        let due = Theme.due(loop.dueDate)
        return VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 8) {
                Text(glyph)
                    .font(.system(size: 13, design: .monospaced))
                    .foregroundStyle(due.urgent ? due.color : .secondary)
                    .frame(width: 9, alignment: .center)
                Text(dueToken(due))
                    .font(.system(size: 13, design: .monospaced))
                    .foregroundStyle(due.urgent ? due.color : Theme.secondary)
                    .lineLimit(1)
                    .fixedSize()
                Text(loop.summary)
                    .font(.system(size: 13, design: .monospaced))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                Spacer(minLength: 6)
            }
            metadata
                .padding(.leading, 17)
        }
        .padding(.vertical, 3)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityText(due))
    }

    private var metadata: some View {
        HStack(spacing: 5) {
            Text(directionPhrase)
                .foregroundStyle(loop.isOwed ? Color.teal : Theme.secondary)
            Text("·").foregroundStyle(.tertiary)
            Text(channelContext)
            if !loop.isFirm { Text("· tentative").italic() }
            if loop.isSnoozed { Text("· snoozed").foregroundStyle(.tertiary) }
        }
        .font(.system(size: 11, design: .monospaced))
        .foregroundStyle(.secondary)
        .lineLimit(1)
    }

    /// Urgency glyph: `!` overdue, `●` today, `·` everything else.
    private var glyph: String {
        switch Theme.urgency(loop.dueDate) {
        case .overdue: return "!"
        case .today: return "●"
        default: return "·"
        }
    }

    /// Compact monospaced due token: `2d` overdue, `today`, the relative/short date otherwise.
    private func dueToken(_ due: (label: String, color: Color, urgent: Bool)) -> String {
        let prefix = (loop.isInferredDate && loop.dueDate != nil) ? "~" : ""
        switch Theme.urgency(loop.dueDate) {
        case .overdue: return prefix + due.label.replacingOccurrences(of: " overdue", with: "")
        case .today: return prefix + "today"
        default: return prefix + due.label
        }
    }

    /// The counterpart name, or nil when it's a placeholder/junk value.
    private var who: String? {
        let raw = loop.counterpart.trimmingCharacters(in: .whitespaces)
        let isJunk = raw.isEmpty || raw.lowercased() == "unknown" || raw.hasPrefix("@") || raw.hasPrefix("<")
        return isJunk ? nil : raw
    }

    /// The key triage signal: who and which way the obligation runs.
    private var directionPhrase: String {
        if loop.isOwed { return who.map { "waiting on \($0)" } ?? "waiting on someone" }
        return who.map { "you owe \($0)" } ?? "you owe"
    }

    /// Source origin: "#channel" / "DM" for Slack, the provider label for Gmail.
    private var channelContext: String {
        if let label = loop.sourceLabel, !label.isEmpty { return label }
        return Theme.channelLabel(loop.channel).lowercased()
    }

    private func accessibilityText(_ due: (label: String, color: Color, urgent: Bool)) -> String {
        var parts = [directionPhrase, loop.summary, Theme.kindLabel(loop.kind), "via \(channelContext)"]
        parts.append(loop.dueDate != nil ? "Due \(due.label)\(loop.isInferredDate ? ", approximate" : "")" : "No due date")
        if !loop.isFirm { parts.append("tentative") }
        return parts.joined(separator: ". ")
    }
}
