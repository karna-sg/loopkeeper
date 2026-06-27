import SwiftUI
import UIKit

/// Full detail for a loop, terminal-clean — the same single-scroll, monospaced look as the task
/// workspace (TaskWorkspaceView). Header line (who · direction · due), then plain `# section` blocks
/// for context / details / a follow-up draft / feedback, and minimal `[ action ]` text buttons.
///
/// Presented as a sheet from the list. Every action still calls the same AppModel method as before.
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
    @State private var inFlight = false

    // Terminal type scale — one monospaced face, hierarchy via weight + dim.
    private let mono = Font.system(size: 13, design: .monospaced)
    private let monoSmall = Font.system(size: 11, design: .monospaced)

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    header
                    context
                    details
                    actions
                    draftBlock
                    feedback
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 14)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(Theme.terminalBG.ignoresSafeArea())
            .navigationTitle(loop.isOwed ? "waiting on" : "you owe")
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

    // MARK: header

    private var header: some View {
        let due = Theme.due(loop.dueDate)
        return VStack(alignment: .leading, spacing: 6) {
            // direction · who · due — the one-glance state line.
            HStack(spacing: 6) {
                Text(loop.isOwed ? "owed" : "owe")
                    .font(.system(size: 13, weight: .semibold, design: .monospaced))
                    .foregroundStyle(loop.isOwed ? Color.teal : Theme.headerAccent)
                Text("·").foregroundStyle(.tertiary)
                Text(directionPhrase).font(mono).foregroundStyle(.secondary)
                Spacer(minLength: 0)
                Text(dueToken(due))
                    .font(mono)
                    .foregroundStyle(due.urgent ? due.color : Theme.secondary)
            }
            Text(loop.summary)
                .font(.system(size: 14, weight: .semibold, design: .monospaced))
                .textSelection(.enabled)
            if let quote = loop.quoteExcerpt, !quote.isEmpty {
                Text("\u{201C}\(quote)\u{201D}")
                    .font(monoSmall).italic().foregroundStyle(.secondary).textSelection(.enabled)
            }
            if loop.sourceWebURL != nil {
                linkButton("open in \(Theme.channelLabel(loop.channel).lowercased())") { openLoopSource(loop, using: openURL) }
                    .padding(.top, 2)
            }
        }
    }

    // MARK: context

    private var context: some View {
        VStack(alignment: .leading, spacing: 6) {
            sectionLabel("# context")
            field("with", loop.counterpart)
            field("source", channelText)
            field("commitment", loop.isFirm ? "firm" : "tentative")
            Text(loop.isFirm ? "a definite obligation with clear intent" : "hedged / conditional / vague — treat with caution")
                .font(monoSmall).foregroundStyle(.tertiary)
            field("date", confidenceLabel)
            Text(confidenceExplanation).font(monoSmall).foregroundStyle(.tertiary)
        }
    }

    // MARK: details (only what's present)

    @ViewBuilder private var details: some View {
        let captured = human(loop.createdTs)
        let snoozedText: String? = loop.snoozeCondition == "reply" ? "until they reply" : (loop.isSnoozed ? human(loop.snoozedUntil) : nil)
        let resolved = human(loop.resolvedTs)
        let hasAny = loop.project != nil || !(loop.tags ?? []).isEmpty || loop.recurrence != nil
            || snoozedText != nil || captured != nil || resolved != nil
        if hasAny {
            VStack(alignment: .leading, spacing: 6) {
                sectionLabel("# details")
                if let project = loop.project { field("project", project) }
                if let tags = loop.tags, !tags.isEmpty { field("tags", tags.joined(separator: ", ")) }
                if let rec = loop.recurrence { field("repeats", rec.lowercased()) }
                if let snoozedText { field("snoozed", snoozedText) }
                if let captured { field("captured", captured) }
                if let resolved { field("resolved", loop.resolution.map { "\(resolved) · \($0)" } ?? resolved) }
            }
        }
    }

    // MARK: actions

    private var actions: some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionLabel("# actions")
            actionButton("mark done", .green) { await model.markDone(loop) }
            Menu {
                Button("Tomorrow") { act { await model.snooze(loop, days: 1) } }
                Button("In 3 days") { act { await model.snooze(loop, days: 3) } }
                Button("Next week") { act { await model.snooze(loop, days: 7) } }
                if loop.isOwed {
                    Divider()
                    Button("Until they reply") { act { await model.snoozeUntilReply(loop) } }
                }
            } label: {
                menuLabel("snooze ▾", .orange)
            }
            Menu {
                Button("None") { Task { await model.recur(loop, rule: "none") } }
                Button("Daily") { Task { await model.recur(loop, rule: "daily") } }
                Button("Weekly") { Task { await model.recur(loop, rule: "weekly") } }
                Button("Monthly") { Task { await model.recur(loop, rule: "monthly") } }
            } label: {
                menuLabel(loop.recurrence.map { "repeats \($0) ▾" } ?? "repeat ▾", .secondary)
            }
            textButton("[ organize… ]", Theme.headerAccent) { showOrganize = true }
            if !loop.isOwed {
                textButton("[ hand off… ]", Theme.headerAccent) { showDelegate = true }
            }
            if loop.status == "closed_candidate" {
                actionButton("confirm it's done", .green) { await model.confirmClose(loop) }
            }
            actionButton("dismiss", .red) { await model.dismiss(loop) }
        }
    }

    // MARK: follow-up draft

    private var draftBlock: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionLabel("# draft")
            if let draft {
                Text(draft).font(mono).foregroundStyle(.primary).textSelection(.enabled)
                textButton("[ copy ]", Theme.headerAccent) { UIPasteboard.general.string = draft; Haptics.tap() }
            } else {
                Button {
                    Task {
                        loadingDraft = true; draftError = nil
                        draft = await model.fetchDraft(loop)
                        if draft == nil { draftError = "Couldn't generate a draft — check the connection and try again." }
                        loadingDraft = false
                    }
                } label: {
                    HStack(spacing: 6) {
                        Text("[ suggest a chaser ]").font(.system(size: 13, weight: .medium, design: .monospaced))
                        if loadingDraft { ProgressView().controlSize(.mini) }
                    }
                    .foregroundStyle(loadingDraft ? AnyShapeStyle(.secondary) : AnyShapeStyle(Theme.headerAccent))
                }
                .buttonStyle(.plain)
                .disabled(loadingDraft)
            }
            if let draftError { Text(draftError).font(monoSmall).foregroundStyle(.red) }
            Text("suggested text only — loopkeeper never sends it for you")
                .font(monoSmall).foregroundStyle(.tertiary)
        }
    }

    // MARK: feedback

    private var feedback: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionLabel("# was this a real loop?")
            HStack(spacing: 14) {
                feedbackButton("yes", selected: loop.userLabel == "true", tint: .green) { act { await model.label(loop, true) } }
                feedbackButton("no", selected: loop.userLabel == "false", tint: .red) { act { await model.label(loop, false) } }
            }
            textButton("[ not a loop — stop showing it ]", .red) { act { await model.notALoop(loop) } }
            Text("dismisses it and stops future scans from recreating this exact item")
                .font(monoSmall).foregroundStyle(.tertiary)
        }
    }

    // MARK: terminal UI helpers (mirrors TaskWorkspaceView)

    @ViewBuilder private func sectionLabel(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 11, weight: .semibold, design: .monospaced))
            .foregroundStyle(Theme.headerAccent)
            .textCase(nil)
    }

    /// A `key   value` line: dim fixed key, primary value.
    @ViewBuilder private func field(_ key: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(key.padding(toLength: 11, withPad: " ", startingAt: 0))
                .font(monoSmall).foregroundStyle(.secondary)
            Text(value).font(mono).foregroundStyle(.primary).textSelection(.enabled)
        }
    }

    /// A minimal text action button: `[ mark done ]`, runs an async AppModel call then dismisses.
    @ViewBuilder private func actionButton(_ title: String, _ tint: Color, _ run: @escaping () async -> Void) -> some View {
        Button {
            Task { inFlight = true; await run(); inFlight = false; dismiss() }
        } label: {
            HStack(spacing: 6) {
                Text("[ \(title) ]").font(.system(size: 13, weight: .medium, design: .monospaced))
                if inFlight { ProgressView().controlSize(.mini) }
            }
            .foregroundStyle(inFlight ? AnyShapeStyle(.secondary) : AnyShapeStyle(tint))
        }
        .buttonStyle(.plain)
        .disabled(inFlight)
    }

    @ViewBuilder private func textButton(_ title: String, _ tint: Color, _ run: @escaping () -> Void) -> some View {
        Button(action: run) {
            Text(title).font(.system(size: 13, weight: .medium, design: .monospaced)).foregroundStyle(tint)
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder private func menuLabel(_ title: String, _ tint: Color) -> some View {
        Text("[ \(title) ]").font(.system(size: 13, weight: .medium, design: .monospaced)).foregroundStyle(tint)
    }

    @ViewBuilder private func linkButton(_ title: String, _ run: @escaping () -> Void) -> some View {
        Button(action: run) {
            HStack(spacing: 5) {
                Text("[ \(title) ]").font(mono)
                Image(systemName: "arrow.up.right").font(.system(size: 10))
            }
            .foregroundStyle(.blue)
        }
        .buttonStyle(.plain)
    }

    /// Feedback toggle: filled accent when it's the current label, dim brackets otherwise.
    @ViewBuilder private func feedbackButton(_ title: String, selected: Bool, tint: Color, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(selected ? "[\u{00D7}] \(title)" : "[ ] \(title)")
                .font(.system(size: 13, weight: selected ? .semibold : .regular, design: .monospaced))
                .foregroundStyle(selected ? tint : Theme.secondary)
        }
        .buttonStyle(.plain)
    }

    // MARK: data helpers

    private var directionPhrase: String {
        let who = loop.counterpart.trimmingCharacters(in: .whitespaces)
        let name = (who.isEmpty || who.lowercased() == "unknown") ? "someone" : who
        return loop.isOwed ? "waiting on \(name)" : "you owe \(name)"
    }

    private func dueToken(_ due: (label: String, color: Color, urgent: Bool)) -> String {
        (loop.isInferredDate && loop.dueDate != nil ? "~" : "") + due.label
    }

    private var channelText: String {
        if let label = loop.sourceLabel, !label.isEmpty { return "\(Theme.channelLabel(loop.channel).lowercased()) · \(label)" }
        return Theme.channelLabel(loop.channel).lowercased()
    }

    private var confidenceLabel: String {
        switch loop.dueConfidence {
        case "explicit": "explicit"
        case "inferred": "inferred"
        default: "no date"
        }
    }

    private var confidenceExplanation: String {
        switch loop.dueConfidence {
        case "explicit": "the deadline was stated outright"
        case "inferred": "the date was inferred from context — double-check it"
        default: "no deadline was detected in the message"
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
