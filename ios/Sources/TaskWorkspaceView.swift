import SwiftUI

/// The per-task workspace (FR-6/7/8): requirements + a 7-stage timeline with artifacts + the three
/// human gates. Loads detail by id, and polls live status while a stage runs. Mirrors LoopDetailView.
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

    var body: some View {
        NavigationStack {
            List {
                if let task {
                    requirements(task)
                    if task.needsAction { gate(task) }
                    stages(task)
                    actions(task)
                } else if loading {
                    HStack { Spacer(); ProgressView(); Spacer() }
                }
            }
            .listSectionSpacing(.compact)
            .navigationTitle(task?.jiraKey ?? "Task")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
            .task { await load() }
            .refreshable { await load() }
            .onDisappear { pollTask?.cancel() }
        }
    }

    // MARK: sections

    @ViewBuilder private func requirements(_ task: EngTask) -> some View {
        Section {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    Text(task.jiraKey).font(.caption.monospaced().weight(.semibold)).foregroundStyle(.secondary)
                    stageChip(task.stage, task.status)
                    Spacer(minLength: 0)
                    if let url = task.jiraUrl, let u = URL(string: url) {
                        Button { openURL(u) } label: { Image(systemName: "arrow.up.right.square") }.buttonStyle(.borderless)
                    }
                }
                Text(task.title).font(.subheadline.weight(.semibold))
                if let d = task.description, !d.isEmpty {
                    Text(d).font(.footnote).foregroundStyle(.secondary).textSelection(.enabled)
                }
                if let ac = task.acceptanceCriteria, !ac.isEmpty {
                    Text("Acceptance").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                    Text(ac).font(.footnote)
                }
                if let labels = task.labels, !labels.isEmpty {
                    Text(labels.map { "#\($0)" }.joined(separator: "  ")).font(.caption2).foregroundStyle(.tertiary)
                }
            }
            .padding(.vertical, 2)
        }
    }

    @ViewBuilder private func stageChip(_ stage: String, _ status: String) -> some View {
        let c = Theme.stageAccent(status)
        let tint = (c == .clear) ? Theme.secondary : c
        Text("\(Theme.stageTitle(stage)) · \(Theme.statusLabel(stage, status))")
            .font(.caption2.weight(.medium))
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(tint.opacity(0.15), in: Capsule())
            .foregroundStyle(tint)
    }

    @ViewBuilder private func gate(_ task: EngTask) -> some View {
        Section("Needs you") {
            switch "\(task.stage):\(task.status)" {
            case "plan:completed_unapproved":
                planGate(task)
            case "pr:proposed":
                prGate(task)
            case "review:comments_received":
                button("Address review comments", "arrow.uturn.backward", .blue) { await model.addressComments(task); await reload() }
            case "merge:ready":
                mergeGate(task)
            default:
                // blocked / deploy:failed / escalated — retry path.
                VStack(alignment: .leading, spacing: 8) {
                    if let err = task.lastError { Text(err).font(.caption).foregroundStyle(.red) }
                    button("Retry", "arrow.clockwise", .orange) { await model.retryTask(task); await reload() }
                }
            }
        }
    }

    @ViewBuilder private func planGate(_ task: EngTask) -> some View {
        if editingPlan {
            TextEditor(text: $planText).frame(minHeight: 240).font(.callout.monospaced())
        } else {
            Text(planText.isEmpty ? (task.artifacts?.plan?.text ?? "—") : planText)
                .font(.callout).textSelection(.enabled)
        }
        Button(editingPlan ? "Done editing" : "Edit / annotate plan") { editingPlan.toggle() }
        button("Approve plan — start development", "checkmark.seal.fill", .green) {
            await model.approvePlan(task, editedText: planText.isEmpty ? nil : planText); await reload()
        }
        button("Send back for revision", "arrow.uturn.backward", .orange) {
            await model.revisePlan(task, note: planText); await reload()
        }
        Text("Approving resumes the same Claude Code session to implement the plan. Nothing merges or deploys without further approval.")
            .font(.caption2).foregroundStyle(.secondary)
    }

    @ViewBuilder private func prGate(_ task: EngTask) -> some View {
        if let pr = task.artifacts?.pr {
            Text(pr.title ?? task.title).font(.subheadline.weight(.semibold))
            if let body = pr.body { Text(body).font(.caption).foregroundStyle(.secondary).lineLimit(8) }
            if let diff = pr.diffSummary { Text(diff).font(.caption).foregroundStyle(.tertiary) }
        }
        button("Approve & open PR", "checkmark.seal.fill", .green) { await model.approvePR(task); await reload() }
        Text("This opens a public PR on GitHub.").font(.caption2).foregroundStyle(.secondary)
    }

    @ViewBuilder private func mergeGate(_ task: EngTask) -> some View {
        if let pr = task.artifacts?.pr, let url = pr.url, let u = URL(string: url) {
            Button { openURL(u) } label: { Label("Review PR #\(pr.number ?? 0)", systemImage: "arrow.up.right.square") }
        }
        Button {
            Task { inFlight = true; await model.approveMerge(task); await reload(); inFlight = false }
        } label: {
            Label("Approve merge", systemImage: "arrow.triangle.merge")
        }
        .tint(.green)
        .disabled(inFlight)
        Text("Merging triggers the prod redeploy. This cannot be undone from the app.")
            .font(.caption2).foregroundStyle(.secondary)
    }

    @ViewBuilder private func stages(_ task: EngTask) -> some View {
        Section("Stages") {
            ForEach(engStages, id: \.self) { stage in
                StageRow(stage: stage, status: statusFor(stage, task), task: task)
            }
        }
    }

    @ViewBuilder private func actions(_ task: EngTask) -> some View {
        if task.stage == "plan" && task.status == "not_started" {
            Section {
                button("Prepare plan", "wand.and.stars", .blue) { await model.preparePlan(task); await reload() }
            }
        }
    }

    // MARK: helpers

    @ViewBuilder private func button(_ title: String, _ icon: String, _ tint: Color, _ run: @escaping () async -> Void) -> some View {
        Button {
            Task { inFlight = true; await run(); inFlight = false }
        } label: {
            Label(title, systemImage: icon)
        }
        .tint(tint)
        .disabled(inFlight)
    }

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

/// One stage in the timeline: a rail dot + name/status, expandable to its artifact.
private struct StageRow: View {
    let stage: String
    let status: String
    let task: EngTask
    @State private var expanded = false
    @Environment(\.openURL) private var openURL

    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            artifact.font(.caption2).foregroundStyle(.secondary)
        } label: {
            HStack(spacing: 8) {
                Image(systemName: Theme.stageDot(status)).font(.footnote).foregroundStyle(Theme.stageAccent(status))
                Text(Theme.stageTitle(stage)).font(.subheadline)
                Spacer(minLength: 4)
                Text(Theme.statusLabel(stage, status)).font(.caption2).foregroundStyle(Theme.stageAccent(status) == .clear ? Theme.secondary : Theme.stageAccent(status))
            }
        }
    }

    @ViewBuilder private var artifact: some View {
        switch stage {
        case "plan":
            if let p = task.artifacts?.plan { Text(p.text ?? "—").textSelection(.enabled) } else { Text("Not generated yet.") }
        case "dev":
            if let d = task.artifacts?.dev {
                Text(d.summary ?? "—")
                if let n = d.filesChanged { Text("\(n) file\(n == 1 ? "" : "s") changed").foregroundStyle(.tertiary) }
                if let i = d.iterations, i > 1 { Text("↻ \(i) iterations").foregroundStyle(.tertiary) }
                if let url = d.branchURL, let u = URL(string: url) { Button { openURL(u) } label: { Label("View branch", systemImage: "arrow.up.right.square") } }
            } else { Text("Not started.") }
        case "test":
            if let t = task.artifacts?.test, let last = t.runs?.last {
                Label(last.passed == true ? "Passed \(last.total ?? 0)/\(last.total ?? 0)" : "Failed", systemImage: last.passed == true ? "checkmark.circle" : "xmark.circle")
                    .foregroundStyle(last.passed == true ? .green : .red)
                if last.passed != true, let s = last.summary { Text(s).font(.caption2.monospaced()).lineLimit(8) }
            } else { Text("Not run.") }
        case "pr":
            if let pr = task.artifacts?.pr {
                Text(pr.title ?? "—")
                if let url = pr.url, let u = URL(string: url) { Button { openURL(u) } label: { Label("Open PR #\(pr.number ?? 0)", systemImage: "arrow.up.right.square") } }
                else { Text("Proposed — not yet opened.").foregroundStyle(.tertiary) }
            } else { Text("No PR yet.") }
        case "review":
            if let r = task.artifacts?.review, let comments = r.comments, !comments.isEmpty {
                ForEach(comments) { c in
                    VStack(alignment: .leading, spacing: 2) {
                        Text("\(c.author ?? "reviewer"): \(c.body ?? "")")
                        if let res = c.resolution { Label(res, systemImage: "checkmark").foregroundStyle(.green).font(.caption2) }
                    }
                }
            } else { Text("No comments.") }
        case "merge":
            if let m = task.artifacts?.merge, let sha = m.commitSha { Text("Merged \(sha)").monospaced() } else { Text("Not merged.") }
        case "deploy":
            if let dep = task.artifacts?.deploy {
                Text("\(dep.env ?? "prod"): \(dep.status ?? "—")")
                if let log = dep.logTail { Text(log).font(.caption2.monospaced()).lineLimit(6) }
            } else { Text("Not deployed.") }
        default:
            Text("—")
        }
    }
}
