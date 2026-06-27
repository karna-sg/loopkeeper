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

    private var api: APIClient

    init(api: APIClient = APIClient()) {
        self.api = api
    }

    func reloadClient() {
        api = APIClient()
    }

    var hasConnections: Bool { !(health?.connected.isEmpty ?? true) }
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
            brief = try await briefTask
            health = try await healthTask
            engineeringTasks = (await tasksTask) ?? engineeringTasks
            errorMessage = nil
            lastUpdated = Date()
            if let brief { LocalNudges.reschedule(brief) }
        } catch {
            errorMessage = friendly(error)
        }
    }

    /// Manual scan: a wider backfill window than the 2-hourly auto-scan, run in the background.
    func scan(days: Int = 7) async {
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
    var sortedTasks: [EngTask] {
        engineeringTasks.sorted { a, b in
            if a.needsAction != b.needsAction { return a.needsAction }
            if a.isRunning != b.isRunning { return a.isRunning }
            return (a.updatedTs ?? "") > (b.updatedTs ?? "")
        }
    }

    var tasksNeedingAction: Int { engineeringTasks.filter(\.needsAction).count }

    func refreshTasks() async { engineeringTasks = (try? await api.tasks()) ?? engineeringTasks }

    /// Fetch a single task's detail + timeline (for the workspace + its live poll).
    func taskDetail(_ id: String) async -> TaskDetailResponse? {
        do {
            let detail = try await api.taskDetail(id)
            upsertTask(detail.task)
            return detail
        } catch {
            errorMessage = friendly(error)
            return nil
        }
    }

    func syncTasks() async { Haptics.tap(); _ = await mutateTasks { try await api.syncTasks() } }
    func preparePlan(_ t: EngTask) async { Haptics.tap(); if await mutateTasks({ try await api.preparePlan(t.id) }) { lastActionLabel = "Planning started" } }
    func approvePlan(_ t: EngTask, editedText: String?) async { Haptics.success(); if await mutateTasks({ try await api.approvePlan(t.id, editedText: editedText) }) { lastActionLabel = "Plan approved — building" } }
    func revisePlan(_ t: EngTask, note: String) async { Haptics.warning(); if await mutateTasks({ try await api.revisePlan(t.id, note: note) }) { lastActionLabel = "Sent back for revision" } }
    func approvePR(_ t: EngTask) async { Haptics.success(); if await mutateTasks({ try await api.approvePR(t.id) }) { lastActionLabel = "Opening PR" } }
    func addressComments(_ t: EngTask) async { Haptics.tap(); if await mutateTasks({ try await api.addressComments(t.id) }) { lastActionLabel = "Addressing comments" } }
    func approveMerge(_ t: EngTask) async { Haptics.success(); if await mutateTasks({ try await api.approveMerge(t.id) }) { lastActionLabel = "Merging" } }
    func retryTask(_ t: EngTask) async { Haptics.tap(); if await mutateTasks({ try await api.retryTask(t.id) }) { lastActionLabel = "Retrying" } }

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
