import SwiftUI

/// A loop row built for a one-glance read: a leading urgency accent, the kind glyph, the summary,
/// a metadata line that states direction ("You owe Priya" / "Waiting on Ravi") + source, and a
/// due label that turns into a colored badge when urgent (tilde-prefixed when the date is inferred).
struct LoopRow: View {
    let loop: OpenLoop
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let due = Theme.due(loop.dueDate)
        return HStack(spacing: 10) {
            RoundedRectangle(cornerRadius: 1.5)
                .fill(Theme.accent(Theme.urgency(loop.dueDate)))
                .frame(width: 3)
                .frame(maxHeight: .infinity)
                .accessibilityHidden(true)
            Image(systemName: Theme.kindIcon(loop.kind))
                .font(.body)
                .foregroundStyle(Theme.secondary)
                .frame(width: 20)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(loop.summary).lineLimit(2)
                metadata
            }
            Spacer(minLength: 8)
            dueBadge(due)
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityText(due))
    }

    private var metadata: some View {
        HStack(spacing: 5) {
            Text(directionPhrase)
                .foregroundStyle(loop.isOwed ? Color.teal : Color.secondary)
            Text("·").foregroundStyle(.tertiary)
            Image(systemName: Theme.channelIcon(loop.channel))
                .font(.caption2)
                .foregroundStyle(Theme.channelTint(loop.channel, scheme: scheme))
            Text(channelContext)
            if !loop.isFirm { Text("· tentative").italic() }
            if loop.isSnoozed { Text("· snoozed").foregroundStyle(.tertiary) }
        }
        .font(.subheadline)
        .foregroundStyle(.secondary)
        .lineLimit(1)
    }

    @ViewBuilder
    private func dueBadge(_ due: (label: String, color: Color, urgent: Bool)) -> some View {
        Text(dueText(due))
            .font(.caption.weight(due.urgent ? .semibold : .regular))
            .foregroundStyle(due.color)
            .padding(.horizontal, due.urgent ? 8 : 0)
            .padding(.vertical, due.urgent ? 3 : 0)
            .background(due.urgent ? due.color.opacity(0.18) : .clear, in: Capsule())
            .fixedSize()
    }

    /// "~Fri" when the date was only inferred by the model, plain otherwise.
    private func dueText(_ due: (label: String, color: Color, urgent: Bool)) -> String {
        (loop.isInferredDate && loop.dueDate != nil) ? "~\(due.label)" : due.label
    }

    /// The counterpart name, or nil when it's a placeholder/junk value.
    private var who: String? {
        let raw = loop.counterpart.trimmingCharacters(in: .whitespaces)
        let isJunk = raw.isEmpty || raw.lowercased() == "unknown" || raw.hasPrefix("@") || raw.hasPrefix("<")
        return isJunk ? nil : raw
    }

    /// The key triage signal: who and which way the obligation runs.
    private var directionPhrase: String {
        if loop.isOwed { return who.map { "Waiting on \($0)" } ?? "Waiting on someone" }
        return who.map { "You owe \($0)" } ?? "You owe"
    }

    /// Source origin: "#channel" / "DM" for Slack, the provider label for Gmail.
    private var channelContext: String {
        if let label = loop.sourceLabel, !label.isEmpty { return label }
        return Theme.channelLabel(loop.channel)
    }

    private func accessibilityText(_ due: (label: String, color: Color, urgent: Bool)) -> String {
        var parts = [directionPhrase, loop.summary, Theme.kindLabel(loop.kind), "via \(channelContext)"]
        parts.append(loop.dueDate != nil ? "Due \(due.label)\(loop.isInferredDate ? ", approximate" : "")" : "No due date")
        if !loop.isFirm { parts.append("tentative") }
        return parts.joined(separator: ". ")
    }
}
