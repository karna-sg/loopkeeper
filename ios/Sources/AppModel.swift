import Foundation
import Observation

/// Observable app state: the brief, backend health, and all lifecycle actions.
@MainActor
@Observable
final class AppModel {
    var brief: Brief?
    var health: Health?
    var isLoading = false
    var isScanning = false
    var errorMessage: String?
    /// Coverage warnings from the most recent scan (degraded search, channel truncation). Empty when healthy.
    var scanWarnings: [String] = []
    /// When the brief was last successfully fetched (drives the "Updated …" freshness line).
    var lastUpdated: Date?
    /// Set after an undoable status change (done/dismiss/confirm/not-a-loop) to surface an Undo toast.
    var lastActionLabel: String?

    /// Phase 2: the user's Jira engineering tasks (My Jira Tasks section). Empty/absent until Jira is connected.
    var engineeringTasks: [EngTask] = []
    /// True while a manual Jira sync (`# tasks` → sync) is pulling newly-assigned tickets. Drives the spinner.
    var isSyncingTasks = false
    /// Guards the one-shot auto-sync on first load so re-renders don't re-trigger it.
    private var didAutoSyncTasks = false

    /// LoopKeeper-side label catalog. Loaded alongside tasks; used by chips + picker + queue view.
    var labels: [EngLabel] = []
    /// jira_ids in saved queue order for the active label (populated on demand by loadLabelOrder).
    var queueOrder: [String] = []

    private var api: APIClient

    init(api: APIClient = APIClient()) {
        self.api = api
    }

    func reloadClient() {
        api = APIClient()
    }

    var hasConnections: Bool { !(health?.connected.isEmpty ?? true) }

    /// Whether Jira is connected (drives showing the `# tasks` section + sync button even with no tasks yet).
    var jiraConnected: Bool { health?.connected.contains { $0.provider.lowercased() == "jira" } ?? false }
    var extractionConfigured: Bool { health?.extractionConfigured ?? false }

    var isEmpty: Bool {
        guard let b = brief else { return true }
        return b.overdue.isEmpty && b.today.isEmpty && b.upcoming.isEmpty && b.noDate.isEmpty && b.awaiting.isEmpty
    }

    func refresh() async {
        isLoading = true
        lastActionLabel = nil // a refresh supersedes any pending undo (it no longer maps to the latest change)
        defer { isLoading = false }
        do {
            async let briefTask = api.brief()
            async let healthTask = api.health()
            async let tasksTask = try? api.tasks() // nil-tolerant: Jira may be unconnected (503)
            async let labelsTask = try? api.labels()
            brief = try await briefTask
            health = (try? await healthTask) ?? health           // non-fatal: a health hiccup shouldn't error the page
            engineeringTasks = (await tasksTask) ?? engineeringTasks
            labels = (await labelsTask) ?? labels
            errorMessage = nil
            lastUpdated = Date()
            if let brief { LocalNudges.reschedule(brief) }
        } catch {
            errorMessage = friendly(error)
        }
    }

    /// Manual scan: re-scan the last day in the background (kept light so it doesn't bog the box).
    func scan(days: Int = 1) async {
        isScanning = true
        lastActionLabel = nil
        defer { isScanning = false }
        do {
            try await api.startScan(days: days)
            await waitForScan()
            await refresh()
        } catch {
            errorMessage = friendly(error)
        }
    }

    /// Poll the background scan until it finishes (or we give up after ~90s).
    private func waitForScan() async {
        for _ in 0..<45 {
            try? await Task.sleep(for: .seconds(2))
            if let status = try? await api.scanStatus(), !status.running {
                if let err = status.lastError { errorMessage = err }
                scanWarnings = status.last?.warnings ?? []
                return
            }
        }
    }

    func markDone(_ loop: OpenLoop) async { Haptics.success(); if await mutate({ try await api.markDone(loop.id) }) { flashUndo("Marked done") } }
    func dismiss(_ loop: OpenLoop) async { Haptics.warning(); if await mutate({ try await api.dismiss(loop.id) }) { flashUndo("Dismissed") } }
    func confirmClose(_ loop: OpenLoop) async { Haptics.success(); if await mutate({ try await api.confirmClose(loop.id) }) { flashUndo("Closed") } }
    func label(_ loop: OpenLoop, _ value: Bool) async { Haptics.tap(); await mutate { try await api.label(loop.id, value ? "true" : "false") } }

    func snooze(_ loop: OpenLoop, days: Int) async {
        Haptics.tap()
        await mutate { try await api.snooze(loop.id, untilISO: Self.iso(daysFromNow: days)) }
    }

    /// Snooze every loop in a bucket by `days` with a single refresh at the end.
    func snoozeAll(_ loops: [OpenLoop], days: Int) async {
        guard !loops.isEmpty else { return }
        Haptics.tap()
        do {
            let until = Self.iso(daysFromNow: days)
            for loop in loops { try await api.snooze(loop.id, untilISO: until) }
            await refresh()
        } catch {
            errorMessage = friendly(error)
        }
    }

    private static func iso(daysFromNow days: Int) -> String {
        ISO8601DateFormatter().string(from: Date().addingTimeInterval(Double(days) * 86_400))
    }

    func notALoop(_ loop: OpenLoop) async { Haptics.warning(); if await mutate({ try await api.notALoop(loop.id) }) { flashUndo("Marked not a loop") } }

    /// Show an Undo toast for ~5s, scoped to this action (a later action or refresh supersedes it).
    private var undoToken = 0
    private func flashUndo(_ label: String) {
        lastActionLabel = label
        undoToken += 1
        let token = undoToken
        Task { try? await Task.sleep(for: .seconds(5)); if undoToken == token { lastActionLabel = nil } }
    }

    func delegate(_ loop: OpenLoop, to: String) async { Haptics.tap(); await mutate { try await api.delegate(loop.id, to: to) } }

    /// Revert the most recent undoable status change.
    func undo() async {
        lastActionLabel = nil
        await mutate { try await api.undo() }
    }

    func recur(_ loop: OpenLoop, rule: String) async { Haptics.tap(); await mutate { try await api.recur(loop.id, rule: rule) } }
    func organize(_ loop: OpenLoop, project: String?, tags: [String]) async { Haptics.tap(); await mutate { try await api.organize(loop.id, project: project, tags: tags) } }
    func snoozeUntilReply(_ loop: OpenLoop) async { Haptics.tap(); await mutate { try await api.snoozeUntilReply(loop.id) } }
    func exportJSON() async -> String? { try? await api.exportData() }

    func stats() async -> Stats? { try? await api.stats() }
    func engStats() async -> EngStats? { try? await api.engStats() }

    /// A running accomplishments doc: closed loops from the last 90 days grouped by counterpart.
    func bragDocText() async -> String {
        let cal = Calendar.current
        let cutoff = cal.date(byAdding: .day, value: -90, to: Date()) ?? Date()
        let iso = ISO8601DateFormatter()
        let done = await archive().filter { loop in
            guard loop.status == "closed", let ts = loop.resolvedTs, let d = iso.date(from: ts) else { return false }
            return d >= cutoff
        }
        guard !done.isEmpty else { return "# Accomplishments\n\nNo loops closed in the last 90 days yet." }
        var byPerson: [String: [OpenLoop]] = [:]
        var order: [String] = []
        for loop in done {
            let key = (loop.counterpart.isEmpty || loop.counterpart.lowercased() == "unknown") ? "General" : loop.counterpart
            if byPerson[key] == nil { order.append(key); byPerson[key] = [] }
            byPerson[key]?.append(loop)
        }
        var out = "# Accomplishments — last 90 days\n\n_\(done.count) loops closed_\n"
        for key in order.sorted(by: { (byPerson[$0]?.count ?? 0) > (byPerson[$1]?.count ?? 0) }) {
            out += "\n## \(key)\n"
            for loop in byPerson[key] ?? [] { out += "- \(loop.summary)\n" }
        }
        return out
    }

    /// Closed + dismissed loops, newest first (for the archive / accomplishments view).
    func archive() async -> [OpenLoop] {
        ((try? await api.loops(status: "closed,dismissed")) ?? []).sorted { ($0.resolvedTs ?? "") > ($1.resolvedTs ?? "") }
    }

    /// Server-side substring search across active loops.
    func search(_ query: String) async -> [OpenLoop] {
        (try? await api.loops(q: query)) ?? []
    }

    /// A copyable standup: what closed since yesterday, what's due today, what you're blocked on.
    func standupText() async -> String {
        let cal = Calendar.current
        let cutoff = cal.date(byAdding: .day, value: -1, to: cal.startOfDay(for: Date())) ?? Date()
        let iso = ISO8601DateFormatter()
        let recentlyDone = await archive().filter { loop in
            guard loop.status == "closed", let ts = loop.resolvedTs, let d = iso.date(from: ts) else { return false }
            return d >= cutoff
        }
        func bullets(_ loops: [OpenLoop], withPerson: Bool) -> String {
            guard !loops.isEmpty else { return "  • —" }
            return loops.map { loop in
                let who = withPerson && !loop.counterpart.isEmpty && loop.counterpart.lowercased() != "unknown" ? " — \(loop.counterpart)" : ""
                return "  • \(loop.summary)\(who)"
            }.joined(separator: "\n")
        }
        return """
        *Since yesterday — done*
        \(bullets(recentlyDone, withPerson: false))

        *Today — due*
        \(bullets(brief?.today ?? [], withPerson: false))

        *Blocked / waiting on*
        \(bullets(brief?.awaiting ?? [], withPerson: true))
        """
    }

    func resetAndRescan() async {
        isScanning = true
        defer { isScanning = false }
        do {
            try await api.reset()
            try await api.startScan(days: 7) // initial backfill: last 7 days
            await waitForScan()
            await refresh()
        } catch {
            errorMessage = friendly(error)
        }
    }

    func fetchDraft(_ loop: OpenLoop) async -> String? {
        do {
            return try await api.draft(loop.id)
        } catch {
            errorMessage = friendly(error)
            return nil
        }
    }

    // MARK: - Engineering (Phase 2)

    /// Tasks sorted for Home: needs-action first, then running, then most-recently-updated.
    /// Stable, predictable order: tasks needing you first, then by Jira key NUMERICALLY (LP-2 before
    /// LP-10). No `updatedTs` tiebreak — that made rows shuffle as a running task ticked.
    var sortedTasks: [EngTask] {
        engineeringTasks.sorted { a, b in
            if a.needsAction != b.needsAction { return a.needsAction }
            let ka = Self.keyOrder(a.jiraKey), kb = Self.keyOrder(b.jiraKey)
            return ka.0 != kb.0 ? ka.0 < kb.0 : ka.1 < kb.1
        }
    }

    /// Split a Jira key into (prefix, number) so keys sort numerically: ("LP", 2) < ("LP", 10).
    private static func keyOrder(_ key: String) -> (String, Int) {
        let parts = key.split(separator: "-")
        let num = Int(parts.last ?? "") ?? Int.max
        let prefix = parts.count > 1 ? parts.dropLast().joined(separator: "-") : key
        return (prefix, num)
    }

    var tasksNeedingAction: Int { engineeringTasks.filter(\.needsAction).count }

    func refreshTasks() async { engineeringTasks = (try? await api.tasks()) ?? engineeringTasks }
    func refreshLabels() async { labels = (try? await api.labels()) ?? labels }

    func label(_ id: String) -> EngLabel? { labels.first { $0.id == id } }

    func createLabel(name: String, color: String) async {
        _ = try? await api.createLabel(name: name, color: color)
        await refreshLabels()
    }

    func updateLabel(id: String, name: String? = nil, color: String? = nil) async {
        _ = try? await api.updateLabel(id: id, name: name, color: color)
        await refreshLabels()
    }

    func deleteLabel(id: String) async {
        try? await api.deleteLabel(id: id)
        await refreshLabels()
        await refreshTasks()
    }

    func attachLabel(task: EngTask, labelId: String) async {
        try? await api.attachLabel(taskId: task.id, labelId: labelId)
        await refreshTasks()
    }

    func detachLabel(task: EngTask, labelId: String) async {
        try? await api.detachLabel(taskId: task.id, labelId: labelId)
        await refreshTasks()
    }

    func loadLabelOrder(_ labelId: String) async {
        queueOrder = (try? await api.labelOrder(labelId)) ?? []
    }

    func reorderLabel(labelId: String, jiraIds: [String]) async {
        queueOrder = jiraIds
        try? await api.reorderLabel(labelId: labelId, jiraIds: jiraIds)
    }

    /// Fetch a single task's detail + timeline (for the workspace + its live poll). Best-effort: a
    /// transient or teardown failure (e.g. the 3s poll firing as the sheet closes) returns nil WITHOUT
    /// raising the global alert — otherwise closing a running task pops a spurious "something went wrong".
    func taskDetail(_ id: String) async -> TaskDetailResponse? {
        do {
            let detail = try await api.taskDetail(id)
            upsertTask(detail.task)
            return detail
        } catch {
            return nil
        }
    }

    /// Tail the agent's redacted JSONL log from `offset`. Best-effort: returns nil on transient errors.
    func taskActivity(_ id: String, offset: Int = 0) async -> ActivityResponse? {
        try? await api.taskActivity(id, offset: offset)
    }

    /// Pull newly-assigned Jira tickets into the store (`POST /tasks/sync`), then re-read the list.
    /// This is the ONLY path that ingests new Jira tasks — plain refresh just re-reads what's stored.
    /// Manual trigger from the `# tasks` header. Surfaces real failures, but stays quiet when Jira
    /// simply isn't connected (503) so it never nags an unconfigured user.
    func syncTasks() async {
        Haptics.tap()
        isSyncingTasks = true
        defer { isSyncingTasks = false }
        do {
            try await api.syncTasks()
            await refreshTasks()
        } catch {
            if let apiError = error as? APIError, apiError.status == 503 { return } // Jira unconnected: no-op
            errorMessage = friendly(error)
        }
    }

    /// Fire-and-forget Jira sync once on first app load, so a freshly-assigned ticket appears without
    /// a manual tap. Non-blocking and silent: never spins the UI, never alerts (errors are swallowed).
    func autoSyncTasksIfNeeded() {
        guard !didAutoSyncTasks else { return }
        didAutoSyncTasks = true
        Task { [weak self] in
            guard let self else { return }
            try? await self.api.syncTasks()
            await self.refreshTasks()
        }
    }

    func preparePlan(_ t: EngTask) async { Haptics.tap(); if await mutateTasks({ try await api.preparePlan(t.id) }) { lastActionLabel = "Planning started" } }
    func approvePlan(_ t: EngTask, editedText: String?) async { Haptics.success(); if await mutateTasks({ try await api.approvePlan(t.id, editedText: editedText) }) { lastActionLabel = "Plan approved — building" } }
    func revisePlan(_ t: EngTask, note: String) async { Haptics.warning(); if await mutateTasks({ try await api.revisePlan(t.id, note: note) }) { lastActionLabel = "Sent back for revision" } }
    func approvePR(_ t: EngTask) async { Haptics.success(); if await mutateTasks({ try await api.approvePR(t.id) }) { lastActionLabel = "Opening PR" } }
    func addressComments(_ t: EngTask) async { Haptics.tap(); if await mutateTasks({ try await api.addressComments(t.id) }) { lastActionLabel = "Addressing comments" } }
    func approveReview(_ t: EngTask) async { Haptics.success(); if await mutateTasks({ try await api.approveReview(t.id) }) { lastActionLabel = "Review approved — ready to merge" } }
    func approveMerge(_ t: EngTask) async { Haptics.success(); if await mutateTasks({ try await api.approveMerge(t.id) }) { lastActionLabel = "Merging" } }
    func retryTask(_ t: EngTask) async { Haptics.tap(); if await mutateTasks({ try await api.retryTask(t.id) }) { lastActionLabel = "Retrying" } }
    /// Retry a budget-blocked task with a raised cap. Lifts the $ cap by `addUsdCents` above current spend
    /// and always grants iteration headroom, so it unblocks both USD- and iteration-capped tasks.
    func retryRaising(_ t: EngTask, addUsdCents: Int) async {
        Haptics.tap()
        let b = t.budget
        let newUsd = max(b?.maxUsdCents ?? 0, b?.usdCentsUsed ?? 0) + addUsdCents
        let newIter = max(b?.maxIterations ?? 0, b?.iterationsUsed ?? 0) + 4
        if await mutateTasks({ try await api.retryTask(t.id, maxUsdCents: newUsd, maxIterations: newIter) }) {
            lastActionLabel = "Retrying (+$\(addUsdCents / 100))"
        }
    }
    func cancelTask(_ t: EngTask) async { Haptics.warning(); if await mutateTasks({ try await api.cancelTask(t.id) }) { lastActionLabel = "Stopping…" } }
    func jiraWritebackDraft(_ t: EngTask) async { Haptics.tap(); _ = await mutateTasks({ try await api.jiraWritebackDraft(t.id) }) }
    func jiraWritebackConfirm(_ t: EngTask) async { Haptics.success(); if await mutateTasks({ try await api.jiraWritebackConfirm(t.id) }) { lastActionLabel = "Posted to Jira" } }
    func confirmVerify(_ t: EngTask) async { Haptics.success(); if await mutateTasks({ try await api.confirmVerify(t.id) }) { lastActionLabel = "Verified" } }
    func retryVerify(_ t: EngTask) async { Haptics.tap(); if await mutateTasks({ try await api.retryVerify(t.id) }) { lastActionLabel = "Re-checking…" } }
    func rollback(_ t: EngTask) async { Haptics.warning(); if await mutateTasks({ try await api.rollback(t.id) }) { lastActionLabel = "Rolling back…" } }
    func fixBuild(_ t: EngTask) async { Haptics.tap(); if await mutateTasks({ try await api.fixBuild(t.id) }) { lastActionLabel = "Fixing build…" } }
    func setModel(_ t: EngTask, model: String?) async { Haptics.tap(); _ = await mutateTasks({ try await api.setModel(t.id, model: model) }) }

    private func upsertTask(_ t: EngTask) {
        if let i = engineeringTasks.firstIndex(where: { $0.id == t.id }) { engineeringTasks[i] = t } else { engineeringTasks.append(t) }
    }

    /// Like `mutate`, but refreshes only the tasks list (engineering actions don't touch the brief).
    @discardableResult
    private func mutateTasks(_ action: () async throws -> Void) async -> Bool {
        do {
            try await action()
            await refreshTasks()
            return true
        } catch {
            errorMessage = friendly(error)
            return false
        }
    }

    @discardableResult
    private func mutate(_ action: () async throws -> Void) async -> Bool {
        do {
            try await action()
            await refresh()
            return true
        } catch {
            errorMessage = friendly(error)
            return false
        }
    }

    private func friendly(_ error: Error) -> String {
        if let apiError = error as? APIError, apiError.status == 503 {
            return apiError.message ?? "That feature isn't configured yet."
        }
        return error.localizedDescription
    }
}
