import SwiftUI

/// The per-task workspace (FR-6/7/8), terminal-clean: a single readable scroll of monospaced text,
/// like the transcript of a build. Header line, requirements as plain prose, the 7-stage pipeline as
/// a compact tree where each stage's artifact is shown inline and fully — nothing hidden in cards or
/// truncated. The three human gates + Prepare/Address actions are plain text buttons at the top.
///
/// Loads detail by id and polls live status while a stage runs. Mirrors LoopDetailView wiring; every
/// action still calls the same AppModel method, and string decoding stays defensive.
struct TaskWorkspaceView: View {
    let taskID: String
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    @State private var task: EngTask?
    @State private var events: [StageEvent] = []
    @State private var loading = true
    @State private var planText = ""
    @State private var editingPlan = false
    @State private var inFlight = false
    @State private var pollTask: Task<Void, Never>?

    // Terminal-clean type scale. One face (monospaced), hierarchy via weight + dim.
    private let mono = Font.system(size: 13, design: .monospaced)
    private let monoSmall = Font.system(size: 11, design: .monospaced)

    var body: some View {
        NavigationStack {
            ScrollView {
                if let task {
                    VStack(alignment: .leading, spacing: 18) {
                        header(task)
                        if task.needsAction { gate(task) }
                        primaryAction(task)
                        requirements(task)
                        pipeline(task)
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 14)
                    .frame(maxWidth: .infinity, alignment: .leading)
                } else if loading {
                    HStack { Spacer(); ProgressView().padding(.top, 60); Spacer() }
                }
            }
            .background(Theme.terminalBG.ignoresSafeArea())
            .navigationTitle(task?.jiraKey ?? "Task")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
            .task { await load() }
            .refreshable { await load() }
            .onDisappear { pollTask?.cancel() }
        }
    }

    // MARK: header

    @ViewBuilder private func header(_ task: EngTask) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            // key · stage · status — the one-glance state line.
            HStack(spacing: 6) {
                Text(task.jiraKey).font(.system(size: 13, weight: .semibold, design: .monospaced))
                Text("·").foregroundStyle(.tertiary)
                Text(Theme.stageTitle(task.stage).lowercased()).font(mono).foregroundStyle(.secondary)
                Text("·").foregroundStyle(.tertiary)
                Text(Theme.statusToken(task.stage, task.status))
                    .font(mono).foregroundStyle(Theme.statusTint(task.status))
                Spacer(minLength: 0)
                if let url = task.jiraUrl, let u = URL(string: url) {
                    Button { openURL(u) } label: { Image(systemName: "arrow.up.right.square") }
                        .buttonStyle(.borderless).foregroundStyle(.secondary)
                }
            }
            Text(task.title)
                .font(.system(size: 14, weight: .semibold, design: .monospaced))
                .textSelection(.enabled)
            metaLine(task)
        }
    }

    /// repo · branch · budget, dim — terminal "context" line.
    @ViewBuilder private func metaLine(_ task: EngTask) -> some View {
        let bits = metaBits(task)
        if !bits.isEmpty {
            Text(bits.joined(separator: "  ·  "))
                .font(monoSmall).foregroundStyle(.tertiary).textSelection(.enabled)
        }
    }

    private func metaBits(_ task: EngTask) -> [String] {
        var bits: [String] = []
        if let r = task.repo, !r.isEmpty { bits.append(r) }
        if let b = task.branch, !b.isEmpty { bits.append(b) }
        if let bud = task.budget, let used = bud.iterationsUsed, let max = bud.maxIterations {
            bits.append("iter \(used)/\(max)")
        }
        return bits
    }

    // MARK: requirements (plain text, fully shown)

    @ViewBuilder private func requirements(_ task: EngTask) -> some View {
        if hasRequirements(task) {
            VStack(alignment: .leading, spacing: 8) {
                sectionLabel("# requirements")
                if let d = task.description, !d.isEmpty {
                    MarkdownText(source: d)
                }
                if let ac = task.acceptanceCriteria, !ac.isEmpty {
                    Text("acceptance:").font(monoSmall).foregroundStyle(.secondary).padding(.top, 2)
                    MarkdownText(source: ac)
                }
                if let labels = task.labels, !labels.isEmpty {
                    Text(labels.map { "#\($0)" }.joined(separator: "  "))
                        .font(monoSmall).foregroundStyle(.tertiary)
                }
            }
        }
    }

    private func hasRequirements(_ task: EngTask) -> Bool {
        !(task.description ?? "").isEmpty
            || !(task.acceptanceCriteria ?? "").isEmpty
            || !(task.labels ?? []).isEmpty
    }

    // MARK: pipeline (7-stage tree, artifacts inline)

    @ViewBuilder private func pipeline(_ task: EngTask) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                sectionLabel("# pipeline")
                Spacer()
                Text("tap a stage to expand").font(.system(size: 10, design: .monospaced)).foregroundStyle(.tertiary)
            }
            .padding(.bottom, 8)
            ForEach(engStages, id: \.self) { stage in
                StageBlock(
                    stage: stage,
                    status: statusFor(stage, task),
                    task: task,
                    isCurrent: stage == task.stage,
                    mono: mono,
                    monoSmall: monoSmall
                )
                if stage != engStages.last {
                    Rectangle().fill(Color.secondary.opacity(0.12)).frame(height: 1)
                }
            }
        }
    }

    // MARK: gates (human-in-the-loop)

    @ViewBuilder private func gate(_ task: EngTask) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionLabel("> needs you", tint: Theme.statusTint(task.status))
            switch "\(task.stage):\(task.status)" {
            case "plan:completed_unapproved":
                planGate(task)
            case "pr:proposed":
                prGate(task)
            case "review:comments_received":
                actionButton("address review comments", .blue) { await model.addressComments(task); await reload() }
            case "merge:ready":
                mergeGate(task)
            default:
                // blocked / deploy:failed / escalated — retry path.
                if let err = task.lastError, !err.isEmpty {
                    Text(err).font(monoSmall).foregroundStyle(.red).textSelection(.enabled)
                }
                actionButton("retry", .orange) { await model.retryTask(task); await reload() }
            }
        }
        .padding(.vertical, 12)
        .padding(.horizontal, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(
            RoundedRectangle(cornerRadius: 6)
                .stroke(Theme.statusTint(task.status).opacity(0.5), lineWidth: 1)
        )
    }

    @ViewBuilder private func planGate(_ task: EngTask) -> some View {
        if editingPlan {
            TextEditor(text: $planText)
                .font(mono)
                .frame(minHeight: 240)
                .scrollContentBackground(.hidden)
                .padding(8)
                .overlay(RoundedRectangle(cornerRadius: 4).stroke(Color.secondary.opacity(0.3)))
        } else {
            MarkdownText(source: planText.isEmpty ? (task.artifacts?.plan?.text ?? "—") : planText)
        }
        textButton(editingPlan ? "[ done editing ]" : "[ edit / annotate ]", .secondary) { editingPlan.toggle() }
        actionButton("approve plan — start dev", .green) {
            await model.approvePlan(task, editedText: planText.isEmpty ? nil : planText); await reload()
        }
        actionButton("send back for revision", .orange) {
            await model.revisePlan(task, note: planText); await reload()
        }
        Text("Approving resumes the same Claude Code session to implement the plan. Nothing merges or deploys without further approval.")
            .font(monoSmall).foregroundStyle(.secondary)
    }

    @ViewBuilder private func prGate(_ task: EngTask) -> some View {
        if let pr = task.artifacts?.pr {
            Text(pr.title ?? task.title)
                .font(.system(size: 13, weight: .semibold, design: .monospaced)).textSelection(.enabled)
            if let body = pr.body, !body.isEmpty {
                MarkdownText(source: body, color: .secondary)
            }
            if let diff = pr.diffSummary, !diff.isEmpty {
                Text(diff).font(monoSmall).foregroundStyle(.tertiary).textSelection(.enabled)
            }
        }
        actionButton("approve & open PR", .green) { await model.approvePR(task); await reload() }
        Text("This opens a public PR on GitHub.").font(monoSmall).foregroundStyle(.secondary)
    }

    @ViewBuilder private func mergeGate(_ task: EngTask) -> some View {
        if let pr = task.artifacts?.pr, let url = pr.url, let u = URL(string: url) {
            linkButton("review PR #\(pr.number ?? 0)") { openURL(u) }
        }
        actionButton("approve merge", .green) { await model.approveMerge(task); await reload() }
        Text("Merging triggers the prod redeploy. This cannot be undone from the app.")
            .font(monoSmall).foregroundStyle(.secondary)
    }

    // MARK: primary action (start of pipeline)

    @ViewBuilder private func primaryAction(_ task: EngTask) -> some View {
        if task.stage == "plan" && task.status == "not_started" {
            actionButton("prepare plan", .blue) { await model.preparePlan(task); await reload() }
        }
    }

    // MARK: small terminal UI helpers

    @ViewBuilder private func sectionLabel(_ text: String, tint: Color = Theme.headerAccent) -> some View {
        Text(text)
            .font(.system(size: 11, weight: .semibold, design: .monospaced))
            .foregroundStyle(tint)
            .textCase(nil)
    }

    /// A minimal text "button" styled like a terminal action: `[ approve plan ]`.
    @ViewBuilder private func actionButton(_ title: String, _ tint: Color, _ run: @escaping () async -> Void) -> some View {
        Button {
            Task { inFlight = true; await run(); inFlight = false }
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
            Text(title).font(.system(size: 13, design: .monospaced)).foregroundStyle(tint)
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder private func linkButton(_ title: String, _ run: @escaping () -> Void) -> some View {
        Button(action: run) {
            HStack(spacing: 5) {
                Text("[ \(title) ]").font(.system(size: 13, design: .monospaced))
                Image(systemName: "arrow.up.right").font(.system(size: 10))
            }
            .foregroundStyle(.blue)
        }
        .buttonStyle(.plain)
    }

    // MARK: data

    private func statusFor(_ stage: String, _ task: EngTask) -> String {
        if stage == task.stage { return task.status }
        if let ev = events.last(where: { $0.toStage == stage }) { return ev.toStatus }
        let idx = engStages.firstIndex(of: stage) ?? 0
        let cur = engStages.firstIndex(of: task.stage) ?? 0
        return idx < cur ? "done" : "not_started"
    }

    private func load() async {
        if let detail = await model.taskDetail(taskID) {
            task = detail.task
            events = detail.events
            if planText.isEmpty { planText = detail.task.artifacts?.plan?.editedText ?? detail.task.artifacts?.plan?.text ?? "" }
        }
        loading = false
        startPollIfNeeded()
    }

    private func reload() async {
        if let detail = await model.taskDetail(taskID) {
            task = detail.task
            events = detail.events
        }
        startPollIfNeeded()
    }

    /// Poll /tasks/:id/status every 3s while a stage runs (bounded; mirrors waitForScan cadence).
    private func startPollIfNeeded() {
        pollTask?.cancel()
        guard task?.isRunning == true else { return }
        pollTask = Task {
            for _ in 0..<200 where !Task.isCancelled {
                try? await Task.sleep(for: .seconds(3))
                guard let detail = await model.taskDetail(taskID) else { continue }
                await MainActor.run { task = detail.task; events = detail.events }
                if detail.task.isRunning == false { break }
            }
        }
    }
}

/// One COLLAPSIBLE stage in the pipeline:
///
///     ▸ plan   approved          (collapsed — tap to open)
///     ▾ plan   approved
///        <artifact: plan text / dev summary / test output / PR link / sha / log>
///
/// The glyph + key + status form the tappable header; the artifact expands beneath it. Stages with
/// no content show no chevron and don't toggle. Default expansion: the current stage and any
/// failed/needs-action stage open automatically; everything else starts collapsed so the screen
/// reads as a scannable list, not a wall of text.
private struct StageBlock: View {
    let stage: String
    let status: String
    let task: EngTask
    let isCurrent: Bool
    let mono: Font
    let monoSmall: Font
    @Environment(\.openURL) private var openURL
    @State private var expanded: Bool?

    /// Computed default: current / failed / needs-attention stages start open.
    private var defaultExpanded: Bool {
        if isCurrent { return true }
        switch status {
        case "failed", "blocked", "completed_unapproved", "proposed", "ready", "comments_received":
            return true
        default:
            return false
        }
    }

    private var isOpen: Bool { expanded ?? defaultExpanded }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                guard hasContent else { return }
                withAnimation(.easeInOut(duration: 0.15)) { expanded = !isOpen }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: hasContent ? (isOpen ? "chevron.down" : "chevron.right") : "minus")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(.tertiary)
                        .frame(width: 10)
                    Text(Theme.stageGlyph(status))
                        .font(mono)
                        .foregroundStyle(Theme.statusTint(status))
                        .frame(width: 10, alignment: .center)
                    Text(Theme.stageKey(stage))
                        .font(.system(size: 13, weight: .semibold, design: .monospaced))
                        .foregroundStyle(stageNameColor)
                    Text(Theme.statusToken(stage, status))
                        .font(mono)
                        .foregroundStyle(Theme.statusTint(status))
                    Spacer(minLength: 0)
                    if !hasContent {
                        Text("—").font(monoSmall).foregroundStyle(.tertiary)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(!hasContent)

            if isOpen && hasContent {
                artifact
                    .padding(.leading, 28)
            }
        }
        .padding(.vertical, 8)
    }

    /// Stage name color: dim for not-yet-reached, accent for the active stage, primary otherwise.
    private var stageNameColor: Color {
        if status == "not_started" { return .secondary }
        if isCurrent { return Theme.headerAccent }
        return .primary
    }

    /// Whether this stage has any artifact worth expanding (drives the chevron + tap).
    private var hasContent: Bool {
        let a = task.artifacts
        switch stage {
        case "plan":   return !((a?.plan?.text ?? "").isEmpty) || (status != "not_started")
        case "dev":    return !((a?.dev?.summary ?? "").isEmpty) || a?.dev?.branchURL != nil || (a?.dev?.filesChanged ?? 0) > 0
        case "test":   return a?.test?.runs?.last != nil
        case "pr":     return a?.pr != nil && (status != "not_started")
        case "review": return !((a?.review?.comments ?? []).isEmpty)
        case "merge":  return !((a?.merge?.commitSha ?? "").isEmpty)
        case "deploy": return a?.deploy != nil
        default:       return false
        }
    }

    /// Per-stage artifact, all content shown in full (long text scrolls with the page).
    @ViewBuilder private var artifact: some View {
        switch stage {
        case "plan":
            if let p = task.artifacts?.plan, let text = p.text, !text.isEmpty {
                proseText(text)
                if let rev = p.revision, rev > 0 { dim("rev \(rev)") }
            } else if status != "not_started" {
                dim("no plan text")
            }
        case "dev":
            if let d = task.artifacts?.dev {
                if let s = d.summary, !s.isEmpty { proseText(s) }
                let stats = devStats(d)
                if !stats.isEmpty { dim(stats.joined(separator: "  ·  ")) }
                if let url = d.branchURL, let u = URL(string: url) { link("branch", u) }
            }
        case "test":
            if let t = task.artifacts?.test, let last = t.runs?.last {
                let total = last.total ?? 0
                let passed = last.passed == true
                Text(passed ? "passed \(total)/\(total)" : "failed \(last.failed ?? 0)/\(total)")
                    .font(mono)
                    .foregroundStyle(passed ? Theme.secondary : Color.red)
                if !passed, let s = last.summary, !s.isEmpty { bodyText(s, color: .red.opacity(0.9)) }
            }
        case "pr":
            if let pr = task.artifacts?.pr {
                if let title = pr.title, !title.isEmpty { bodyText(title) }
                if let diff = pr.diffSummary, !diff.isEmpty { dim(diff) }
                if let url = pr.url, let u = URL(string: url) { link("PR #\(pr.number ?? 0)", u) }
                else if status != "not_started" { dim("proposed — not yet opened") }
            }
        case "review":
            if let r = task.artifacts?.review, let comments = r.comments, !comments.isEmpty {
                ForEach(comments) { c in
                    VStack(alignment: .leading, spacing: 2) {
                        (Text(c.author ?? "reviewer").foregroundColor(Theme.headerAccent)
                            + Text(": \(c.body ?? "")").foregroundColor(.primary))
                            .font(mono).textSelection(.enabled)
                        if let res = c.resolution, !res.isEmpty {
                            Text("  ✓ \(res)").font(monoSmall).foregroundStyle(Theme.mdStrong)
                        }
                    }
                }
            }
        case "merge":
            if let m = task.artifacts?.merge, let sha = m.commitSha, !sha.isEmpty {
                (Text("merged ").foregroundColor(.secondary) + Text(sha).foregroundColor(Theme.mdCode))
                    .font(mono).textSelection(.enabled)
            }
        case "deploy":
            if let dep = task.artifacts?.deploy {
                (Text("\(dep.env ?? "prod"): ").foregroundColor(.secondary)
                    + Text(dep.status ?? "—").foregroundColor(Theme.statusTint(dep.status ?? "")))
                    .font(mono).textSelection(.enabled)
                if let log = dep.logTail, !log.isEmpty { bodyText(log, color: .secondary) }
            }
        default:
            EmptyView()
        }
    }

    private func devStats(_ d: DevArtifact) -> [String] {
        var stats: [String] = []
        if let n = d.filesChanged { stats.append("\(n) file\(n == 1 ? "" : "s") changed") }
        if let i = d.iterations, i > 1 { stats.append("\(i) iterations") }
        return stats
    }

    /// Markdown-bearing prose (plan text, dev summary) rendered clean — no raw `#`, `**`, `-`.
    @ViewBuilder private func proseText(_ s: String) -> some View {
        MarkdownText(source: s, size: 13)
    }

    /// Raw verbatim text (logs, single-line titles) — shown exactly as received.
    @ViewBuilder private func bodyText(_ s: String, color: Color = .primary) -> some View {
        Text(s).font(mono).foregroundStyle(color).textSelection(.enabled)
    }

    @ViewBuilder private func dim(_ s: String) -> some View {
        Text(s).font(monoSmall).foregroundStyle(.tertiary)
    }

    @ViewBuilder private func link(_ title: String, _ u: URL) -> some View {
        Button { openURL(u) } label: {
            HStack(spacing: 5) {
                Text("[ \(title) ]").font(mono)
                Image(systemName: "arrow.up.right").font(.system(size: 10))
            }
            .foregroundStyle(.blue)
        }
        .buttonStyle(.plain)
    }
}
