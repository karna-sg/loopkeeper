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
    @State private var activityLines: [String] = []
    @State private var activityOffset: Int = 0
    @State private var activityDone: Bool = false
    @State private var activityPollTask: Task<Void, Never>?
    @State private var requirementsExpanded = true
    @State private var diffExpanded = false

    // Terminal-clean type scale. One face (monospaced), hierarchy via weight + dim.
    private let mono = Font.system(size: 13, design: .monospaced)
    private let monoSmall = Font.system(size: 11, design: .monospaced)

    var body: some View {
        NavigationStack {
            ScrollView {
                if let task {
                    VStack(alignment: .leading, spacing: 18) {
                        header(task)
                        if !task.isRunning { modelPicker(task) }
                        if task.isRunning { stopAction(task) }
                        if task.needsAction { gate(task) }
                        primaryAction(task)
                        requirements(task)
                        if task.isRunning || !activityLines.isEmpty {
                            ActivityFeedView(lines: activityLines, done: activityDone)
                        }
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
            .onDisappear {
                pollTask?.cancel()
                activityPollTask?.cancel()
            }
        }
    }

    // MARK: model picker (LP-27)

    @ViewBuilder private func modelPicker(_ task: EngTask) -> some View {
        let label: String = {
            switch task.claudeModel {
            case "claude-opus-4-8": return "opus"
            case "claude-sonnet-4-6": return "sonnet"
            case "claude-haiku-4-5-20251001": return "haiku"
            default: return "default"
            }
        }()
        Menu {
            Button("default (global)") { Task { await model.setModel(task, model: nil); await reload() } }
            Button("sonnet  (claude-sonnet-4-6)") { Task { await model.setModel(task, model: "claude-sonnet-4-6"); await reload() } }
            Button("opus    (claude-opus-4-8)") { Task { await model.setModel(task, model: "claude-opus-4-8"); await reload() } }
            Button("haiku   (claude-haiku-4-5-20251001)") { Task { await model.setModel(task, model: "claude-haiku-4-5-20251001"); await reload() } }
        } label: {
            Text("model: \(label)")
                .font(monoSmall).foregroundStyle(.secondary)
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
                    .font(mono).foregroundStyle(Theme.tickTint(task.status))
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
        if let bud = task.budget {
            if let used = bud.iterationsUsed, let max = bud.maxIterations {
                bits.append("iter \(used)/\(max)")
            }
            // Show cost once the agent has started work; n/a signals subscription OAuth.
            if task.status != "not_started" {
                let cents = bud.usdCentsUsed ?? 0
                bits.append(cents > 0 ? String(format: "$%.2f", Double(cents) / 100.0) : "n/a")
            }
        }
        return bits
    }

    // MARK: requirements (plain text, fully shown)

    @ViewBuilder private func requirements(_ task: EngTask) -> some View {
        if hasRequirements(task) {
            VStack(alignment: .leading, spacing: 8) {
                Button {
                    withAnimation(.easeInOut(duration: 0.15)) { requirementsExpanded.toggle() }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: requirementsExpanded ? "chevron.down" : "chevron.right")
                            .font(.system(size: 9, weight: .semibold)).foregroundStyle(.tertiary).frame(width: 10)
                        sectionLabel("# requirements")
                        Spacer(minLength: 0)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                if requirementsExpanded {
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
            ForEach(pipelineStages(task), id: \.self) { stage in
                StageBlock(
                    stage: stage,
                    status: statusFor(stage, task),
                    task: task,
                    isCurrent: stage == task.stage,
                    mono: mono,
                    monoSmall: monoSmall
                )
                if stage != pipelineStages(task).last {
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
            case "review:awaiting_review", "review:comments_addressed":
                reviewGate(task)
            case "merge:ready":
                mergeGate(task)
            case "verify:awaiting_review":
                verifyGate(task)
            case "verify:failed":
                verifyFailedGate(task)
            case "rollback:ready":
                actionButton("confirm rollback", .red) { await model.rollback(task); await reload() }
            case "rollback:failed":
                if let err = task.lastError, !err.isEmpty {
                    Text(err).font(monoSmall).foregroundStyle(.red).textSelection(.enabled)
                }
                actionButton("retry rollback", .orange) { await model.rollback(task); await reload() }
            case "deploy:failed":
                deployFailedGate(task)
            default:
                // blocked / escalated — retry path (with a budget-raise option when the cap was the cause).
                blockedGate(task)
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

    /// blocked / escalated retry path. When the task hit a budget cap, offer to raise it and retry
    /// (the backend /retry route accepts {maxUsdCents, maxIterations}); otherwise a plain retry.
    @ViewBuilder private func blockedGate(_ task: EngTask) -> some View {
        if let err = task.lastError, !err.isEmpty {
            Text(err).font(monoSmall).foregroundStyle(.red).textSelection(.enabled)
        }
        if let b = task.budget, budgetExhausted(b) {
            if (b.usdCentsUsed ?? 0) >= (b.maxUsdCents ?? Int.max) {
                Text(String(format: "budget: $%.2f / $%.2f — cap reached", Double(b.usdCentsUsed ?? 0) / 100.0, Double(b.maxUsdCents ?? 0) / 100.0))
                    .font(monoSmall).foregroundStyle(.orange)
            } else {
                Text("iterations: \(b.iterationsUsed ?? 0) / \(b.maxIterations ?? 0) — cap reached")
                    .font(monoSmall).foregroundStyle(.orange)
            }
            actionButton("raise budget +$5 & retry", .green) { await model.retryRaising(task, addUsdCents: 500); await reload() }
            actionButton("raise budget +$10 & retry", .blue) { await model.retryRaising(task, addUsdCents: 1000); await reload() }
        } else {
            actionButton("retry", .orange) { await model.retryTask(task); await reload() }
        }
    }

    private func budgetExhausted(_ b: TaskBudget) -> Bool {
        (b.usdCentsUsed ?? 0) >= (b.maxUsdCents ?? Int.max) || (b.iterationsUsed ?? 0) >= (b.maxIterations ?? Int.max)
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
        acCheckList(task)
        diffExpander(task)
        actionButton("approve & open PR", .green) { await model.approvePR(task); await reload() }
        Text("This opens a public PR on GitHub.").font(monoSmall).foregroundStyle(.secondary)
    }

    @ViewBuilder private func acCheckList(_ task: EngTask) -> some View {
        if let items = task.artifacts?.acCheck, !items.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                Text("ac check:").font(monoSmall).foregroundStyle(.secondary)
                ForEach(items) { item in
                    let passed = item.pass == true
                    HStack(alignment: .top, spacing: 6) {
                        Text(passed ? "✓" : "✗")
                            .font(monoSmall)
                            .foregroundStyle(passed ? Theme.mdStrong : Color.red)
                            .frame(width: 12, alignment: .leading)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(item.criterion ?? "—")
                                .font(monoSmall)
                                .foregroundStyle(.primary)
                                .textSelection(.enabled)
                            if let ev = item.evidence, !ev.isEmpty {
                                Text(ev)
                                    .font(monoSmall)
                                    .foregroundStyle(.secondary)
                                    .textSelection(.enabled)
                            }
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder private func reviewGate(_ task: EngTask) -> some View {
        if let pr = task.artifacts?.pr, let url = pr.url, let u = URL(string: url) {
            linkButton("review PR #\(pr.number ?? 0)") { openURL(u) }
        }
        diffExpander(task)
        actionButton("approve review — ready to merge", .green) { await model.approveReview(task); await reload() }
        Text("Review the PR on GitHub, then approve here to advance to the merge gate.")
            .font(monoSmall).foregroundStyle(.secondary)
    }

    @ViewBuilder private func mergeGate(_ task: EngTask) -> some View {
        if let pr = task.artifacts?.pr, let url = pr.url, let u = URL(string: url) {
            linkButton("review PR #\(pr.number ?? 0)") { openURL(u) }
        }
        diffExpander(task)
        actionButton("approve merge", .green) { await model.approveMerge(task); await reload() }
        Text("Merging triggers the prod redeploy. This cannot be undone from the app.")
            .font(monoSmall).foregroundStyle(.secondary)
    }

    @ViewBuilder private func diffExpander(_ task: EngTask) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            textButton(diffExpanded ? "[ hide diff ]" : "[ show diff ]", .secondary) {
                diffExpanded.toggle()
            }
            if diffExpanded {
                DiffView(taskId: task.id, fallbackURL: task.artifacts?.pr?.url.flatMap(URL.init))
                    .padding(.top, 4)
            }
        }
    }

    @ViewBuilder private func verifyGate(_ task: EngTask) -> some View {
        if let v = task.artifacts?.verify {
            if let s = v.changeSummary, !s.isEmpty {
                (Text("shipped: ").foregroundColor(.secondary) + Text(s)).font(monoSmall).textSelection(.enabled)
            }
            let ok = v.healthOk ?? false
            (Text("smoke: ").foregroundColor(.secondary) + Text(ok ? "✓ healthy" : "✗ check failed").foregroundColor(ok ? .secondary : .red))
                .font(monoSmall)
            if let url = v.runUrl, let u = URL(string: url) { linkButton("view deploy run") { openURL(u) } }
        }
        actionButton("verified — looks good", .green) { await model.confirmVerify(task); await reload() }
        actionButton("roll back", .orange) { await model.rollback(task); await reload() }
        Text("Confirm the deployed change is live and working, or roll back (revert + redeploy).")
            .font(monoSmall).foregroundStyle(.secondary)
    }

    @ViewBuilder private func verifyFailedGate(_ task: EngTask) -> some View {
        if let v = task.artifacts?.verify, let o = v.output, !o.isEmpty {
            Text(o).font(monoSmall).foregroundStyle(.red).textSelection(.enabled)
        }
        actionButton("re-check", .blue) { await model.retryVerify(task); await reload() }
        actionButton("roll back", .orange) { await model.rollback(task); await reload() }
        Text("Rollback reverts the code (revert + redeploy). It does not undo data/migrations.")
            .font(monoSmall).foregroundStyle(.secondary)
    }

    /// Deploy failed — the recovery depends on WHY: a build failure needs an agent code fix (not a CI
    /// re-run); a transient infra failure can be re-run; either can roll back.
    @ViewBuilder private func deployFailedGate(_ task: EngTask) -> some View {
        let dep = task.artifacts?.deploy
        if let url = dep?.runUrl, let u = URL(string: url) { linkButton("view run") { openURL(u) } }
        if dep?.failureKind == "ci_build" {
            if let e = dep?.ciError, !e.isEmpty {
                Text(e).font(monoSmall).foregroundStyle(.red).textSelection(.enabled)
            } else {
                Text("CI/build failed on main.").font(monoSmall).foregroundStyle(.red)
            }
            actionButton("fix build (agent)", .blue) { await model.fixBuild(task); await reload() }
            actionButton("roll back", .orange) { await model.rollback(task); await reload() }
            Text("The build is broken — the agent fixes it (new PR → re-merge → redeploy). A CI re-run alone won't help.")
                .font(monoSmall).foregroundStyle(.secondary)
        } else {
            if let log = dep?.logTail, !log.isEmpty {
                Text(log).font(monoSmall).foregroundStyle(.red).textSelection(.enabled)
            } else if let err = task.lastError, !err.isEmpty {
                Text(err).font(monoSmall).foregroundStyle(.red).textSelection(.enabled)
            }
            actionButton(dep?.failureKind == "cd_infra" ? "retry deploy" : "retry", .orange) { await model.retryTask(task); await reload() }
            actionButton("roll back", .orange) { await model.rollback(task); await reload() }
        }
    }

    // MARK: stop action (visible while a stage is running)

    @ViewBuilder private func stopAction(_ task: EngTask) -> some View {
        actionButton("stop", .orange) { await model.cancelTask(task); await reload() }
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

    /// The linear pipeline, plus a rollback row only when this task actually entered rollback.
    private func pipelineStages(_ task: EngTask) -> [String] {
        (task.stage == "rollback" || task.artifacts?.rollback != nil) ? engStages + ["rollback"] : engStages
    }

    private func statusFor(_ stage: String, _ task: EngTask) -> String {
        if stage == task.stage { return task.status }
        if let ev = events.last(where: { $0.toStage == stage }) { return ev.toStatus }
        let idx = engStages.firstIndex(of: stage) ?? 0
        let cur = engStages.firstIndex(of: task.stage) ?? 0
        return idx < cur ? "done" : "not_started"
    }

    private func load() async {
        // Reset activity state so a re-enter of the view re-reads from the start of the latest run.
        activityLines = []
        activityOffset = 0
        activityDone = false
        activityPollTask?.cancel()

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
        startActivityPollIfNeeded()
    }

    /// Poll /tasks/:id/activity every 2s, advancing the byte cursor to stream new lines.
    private func startActivityPollIfNeeded() {
        activityPollTask?.cancel()
        guard task?.isRunning == true else { return }
        activityPollTask = Task {
            for _ in 0..<400 where !Task.isCancelled {
                try? await Task.sleep(for: .seconds(2))
                guard !activityDone else { break }
                if let response = await model.taskActivity(taskID, offset: activityOffset) {
                    await MainActor.run {
                        if !response.lines.isEmpty { activityLines.append(contentsOf: response.lines) }
                        activityOffset = response.nextOffset
                        activityDone = response.done
                    }
                    if response.done { break }
                }
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
                        .foregroundStyle(Theme.tickTint(status))
                        .frame(width: 10, alignment: .center)
                    Text(Theme.stageKey(stage))
                        .font(.system(size: 13, weight: .semibold, design: .monospaced))
                        .foregroundStyle(stageNameColor)
                    Text(Theme.statusToken(stage, status))
                        .font(mono)
                        .foregroundStyle(Theme.tickTint(status))
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
        case "verify": return a?.verify != nil
        case "rollback": return a?.rollback != nil
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
                if dep.ci != nil || dep.cd != nil {
                    (Text("CI ").foregroundColor(.secondary) + Text(ciCdLabel(dep.ci)).foregroundColor(ciCdColor(dep.ci))
                        + Text("   CD ").foregroundColor(.secondary) + Text(ciCdLabel(dep.cd)).foregroundColor(ciCdColor(dep.cd)))
                        .font(mono).textSelection(.enabled)
                }
                if let url = dep.runUrl, let u = URL(string: url) { link("view run", u) }
                if let log = dep.logTail, !log.isEmpty { bodyText(log, color: .secondary) }
            }
        case "verify":
            if let v = task.artifacts?.verify {
                if let s = v.changeSummary, !s.isEmpty {
                    (Text("shipped ").foregroundColor(.secondary) + Text(s)).font(mono).textSelection(.enabled)
                }
                if let checks = v.checks {
                    ForEach(Array(checks.enumerated()), id: \.offset) { _, c in
                        (Text(c.ok == true ? "✓ " : "✗ ").foregroundColor(c.ok == true ? Theme.secondary : .red)
                            + Text("\(c.name ?? "check")\(c.detail.map { " · \($0)" } ?? "")").foregroundColor(.secondary))
                            .font(monoSmall).textSelection(.enabled)
                    }
                }
                if let url = v.runUrl, let u = URL(string: url) { link("view run", u) }
            }
        case "rollback":
            if let rb = task.artifacts?.rollback {
                (Text("rollback ").foregroundColor(.secondary) + Text(rb.status ?? "—").foregroundColor(Theme.statusTint(rb.status ?? "")))
                    .font(mono).textSelection(.enabled)
                if let t = rb.targetSha, !t.isEmpty { dim("reverted \(t)") }
                if let url = rb.prUrl, let u = URL(string: url) { link("revert PR", u) }
                if let log = rb.logTail, !log.isEmpty { bodyText(log, color: .secondary) }
            }
        default:
            EmptyView()
        }
    }

    /// A GitHub Actions job conclusion as a terminal-style label.
    private func ciCdLabel(_ c: String?) -> String {
        switch c {
        case "success": return "✓ passed"
        case "failure", "cancelled", "timed_out": return "✗ \(c!)"
        case nil: return "… running"
        default: return c ?? "—"
        }
    }
    private func ciCdColor(_ c: String?) -> Color {
        switch c {
        case "success": return .secondary
        case "failure", "cancelled", "timed_out": return .red
        case nil: return .blue
        default: return .secondary
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
