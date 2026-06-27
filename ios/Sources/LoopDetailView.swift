import SwiftUI
import UIKit

/// Full detail for a loop: context, quality signals, lifecycle actions, a suggested follow-up
/// draft, and a precision label. Presented as a sheet from the list.
struct LoopDetailView: View {
    let loop: OpenLoop
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var draft: String?
    @State private var draftError: String?
    @State private var loadingDraft = false
    @State private var showDelegate = false
    @State private var delegateTo = ""
    @State private var showOrganize = false

    var body: some View {
        NavigationStack {
            List {
                contextSection
                qualitySection
                detailsSection
                actionsSection
                draftSection
                labelSection
            }
            .navigationTitle("Loop")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
            .alert("Hand off to…", isPresented: $showDelegate) {
                TextField("Name", text: $delegateTo)
                Button("Hand off") { let to = delegateTo; act { await model.delegate(loop, to: to) } }
                Button("Cancel", role: .cancel) { delegateTo = "" }
            } message: {
                Text("Flips this loop to \u{201C}waiting on\u{201D} them.")
            }
            .sheet(isPresented: $showOrganize) { OrganizeView(loop: loop) }
        }
    }

    private var contextSection: some View {
        Section {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: Theme.kindIcon(loop.kind)).foregroundStyle(.secondary)
                    .accessibilityLabel(Theme.kindLabel(loop.kind))
                VStack(alignment: .leading, spacing: 6) {
                    Text(loop.summary).font(.headline)
                    if let quote = loop.quoteExcerpt, !quote.isEmpty {
                        Text("\u{201C}\(quote)\u{201D}").font(.caption).italic().foregroundStyle(.secondary)
                    }
                }
            }
            LabeledContent("Direction", value: loop.isOwed ? "Owed to you" : "You owe")
            LabeledContent("With", value: loop.counterpart)
            LabeledContent("Channel", value: channelText)
            LabeledContent("Due") {
                let due = Theme.due(loop.dueDate)
                Text((loop.isInferredDate && loop.dueDate != nil ? "~" : "") + due.label).foregroundStyle(due.color)
            }
            if loop.sourceWebURL != nil {
                Button { openLoopSource(loop, using: openURL) } label: { Label("View in \(Theme.channelLabel(loop.channel))", systemImage: "arrow.up.right.square") }
            }
        }
    }

    private var qualitySection: some View {
        Section("Quality") {
            LabeledContent("Commitment", value: loop.isFirm ? "Firm" : "Tentative")
            Text(loop.isFirm ? "A definite obligation with clear intent." : "Hedged, conditional, or vague — treat with caution.")
                .font(.caption).foregroundStyle(.secondary)
            LabeledContent("Date confidence", value: confidenceLabel)
            Text(confidenceExplanation).font(.caption).foregroundStyle(.secondary)
        }
    }

    private var detailsSection: some View {
        let captured = human(loop.createdTs)
        let snoozedText: String? = loop.snoozeCondition == "reply" ? "Until they reply" : (loop.isSnoozed ? human(loop.snoozedUntil) : nil)
        let resolved = human(loop.resolvedTs)
        return Section("Details") {
            if let project = loop.project { LabeledContent("Project", value: project) }
            if let tags = loop.tags, !tags.isEmpty { LabeledContent("Tags", value: tags.joined(separator: ", ")) }
            if let rec = loop.recurrence { LabeledContent("Repeats", value: rec.capitalized) }
            if let snoozedText { LabeledContent("Snoozed", value: snoozedText) }
            if let captured { LabeledContent("Captured", value: captured) }
            if let resolved { LabeledContent("Resolved", value: loop.resolution.map { "\(resolved) · \($0)" } ?? resolved) }
        }
    }

    private var actionsSection: some View {
        Section("Actions") {
            Button { act { await model.markDone(loop) } } label: { Label("Mark done", systemImage: "checkmark.circle") }
            Menu {
                Button("Tomorrow") { act { await model.snooze(loop, days: 1) } }
                Button("In 3 days") { act { await model.snooze(loop, days: 3) } }
                Button("Next week") { act { await model.snooze(loop, days: 7) } }
                if loop.isOwed {
                    Divider()
                    Button("Until they reply") { act { await model.snoozeUntilReply(loop) } }
                }
            } label: {
                Label("Snooze", systemImage: "clock")
            }
            Menu {
                Button("None") { Task { await model.recur(loop, rule: "none") } }
                Button("Daily") { Task { await model.recur(loop, rule: "daily") } }
                Button("Weekly") { Task { await model.recur(loop, rule: "weekly") } }
                Button("Monthly") { Task { await model.recur(loop, rule: "monthly") } }
            } label: {
                Label(loop.recurrence.map { "Repeats \($0)" } ?? "Repeat", systemImage: "repeat")
            }
            Button { showOrganize = true } label: { Label("Organize…", systemImage: "folder.badge.gearshape") }
            if !loop.isOwed {
                Button { showDelegate = true } label: { Label("Hand off…", systemImage: "person.crop.circle.badge.plus") }
            }
            Button(role: .destructive) { act { await model.dismiss(loop) } } label: { Label("Dismiss", systemImage: "trash") }
            if loop.status == "closed_candidate" {
                Button { act { await model.confirmClose(loop) } } label: {
                    Label("Confirm it's done", systemImage: "checkmark.seal.fill")
                }
            }
        }
    }

    private var draftSection: some View {
        Section("Follow-up draft") {
            if let draft {
                Text(draft).font(.callout)
                Button { UIPasteboard.general.string = draft; Haptics.tap() } label: { Label("Copy", systemImage: "doc.on.doc") }
            } else {
                Button {
                    Task {
                        loadingDraft = true; draftError = nil
                        draft = await model.fetchDraft(loop)
                        if draft == nil { draftError = "Couldn't generate a draft — check the connection and try again." }
                        loadingDraft = false
                    }
                } label: {
                    HStack {
                        Label("Suggest a chaser", systemImage: "sparkles")
                        if loadingDraft { Spacer(); ProgressView() }
                    }
                }
                .disabled(loadingDraft)
            }
            if let draftError { Text(draftError).font(.caption).foregroundStyle(.red) }
            Text("Suggested text only — Loopkeeper never sends it for you.")
                .font(.caption2).foregroundStyle(.secondary)
        }
    }

    private var labelSection: some View {
        Section("Was this a real loop?") {
            HStack {
                labelButton("Yes", icon: "hand.thumbsup", selected: loop.userLabel == "true", tint: .green) { act { await model.label(loop, true) } }
                Spacer()
                labelButton("No", icon: "hand.thumbsdown", selected: loop.userLabel == "false", tint: .red) { act { await model.label(loop, false) } }
            }
            Button(role: .destructive) { act { await model.notALoop(loop) } } label: {
                Label("Not a loop — stop showing it", systemImage: "xmark.bin")
            }
            Text("Dismisses it and stops future scans from recreating this exact item.")
                .font(.caption2).foregroundStyle(.secondary)
        }
    }

    /// A feedback button that reads "prominent + filled icon" once it's the current label.
    @ViewBuilder
    private func labelButton(_ title: String, icon: String, selected: Bool, tint: Color, action: @escaping () -> Void) -> some View {
        let label = Label(title, systemImage: selected ? "\(icon).fill" : icon)
        if selected {
            Button(action: action) { label }.buttonStyle(.borderedProminent).tint(tint)
        } else {
            Button(action: action) { label }.buttonStyle(.bordered).tint(tint)
        }
    }

    // MARK: helpers

    private var channelText: String {
        if let label = loop.sourceLabel, !label.isEmpty { return "\(Theme.channelLabel(loop.channel)) · \(label)" }
        return Theme.channelLabel(loop.channel)
    }

    private var confidenceLabel: String {
        switch loop.dueConfidence {
        case "explicit": "Explicit"
        case "inferred": "Inferred"
        default: "No date"
        }
    }

    private var confidenceExplanation: String {
        switch loop.dueConfidence {
        case "explicit": "The deadline was stated outright."
        case "inferred": "The date was inferred from context — double-check it."
        default: "No deadline was detected in the message."
        }
    }

    private func human(_ iso: String?) -> String? {
        guard let iso, let date = ISO8601DateFormatter().date(from: iso) else { return nil }
        let f = DateFormatter()
        f.dateStyle = .medium
        f.timeStyle = .short
        return f.string(from: date)
    }

    private func act(_ work: @escaping () async -> Void) {
        Task {
            await work()
            dismiss()
        }
    }
}
