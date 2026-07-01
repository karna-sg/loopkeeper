import Foundation

/// Persisted filter dimensions for the engineering task list.
/// Stage/statusGroup/tags combine with AND; within tags it's OR.
struct TaskFilterState {
    var stage: String = "all"
    var statusGroup: String = "any"
    var tags: Set<String> = []
    var query: String = ""

    var isActive: Bool {
        stage != "all" || statusGroup != "any" || !tags.isEmpty || !query.isEmpty
    }

    var activeCount: Int {
        (stage != "all" ? 1 : 0) + (statusGroup != "any" ? 1 : 0) + tags.count + (!query.isEmpty ? 1 : 0)
    }
}

/// Pure filter: stage "all" / statusGroup "any" / empty tags / empty query → passes everything through.
/// Dimensions combine with AND; within tags it's OR (task matches if it has ANY selected tag).
func applyTaskFilters(_ tasks: [EngTask], filter: TaskFilterState) -> [EngTask] {
    guard filter.isActive else { return tasks }
    return tasks.filter { task in
        guard filter.stage == "all" || task.stage == filter.stage else { return false }
        let statusOK: Bool
        switch filter.statusGroup {
        case "needs-you": statusOK = task.needsAction
        case "running":   statusOK = task.isRunning
        case "blocked":   statusOK = task.status == "blocked"
        case "done":      statusOK = !task.needsAction && !task.isRunning && task.status != "blocked"
        default:          statusOK = true
        }
        guard statusOK else { return false }
        if !filter.tags.isEmpty {
            let taskTags = Set((task.labels ?? []) + (task.components ?? []))
            guard !filter.tags.isDisjoint(with: taskTags) else { return false }
        }
        if !filter.query.isEmpty {
            let q = filter.query.lowercased()
            let matches = task.jiraKey.lowercased().contains(q)
                || task.title.lowercased().contains(q)
                || (task.labels ?? []).contains { $0.lowercased().contains(q) }
                || (task.components ?? []).contains { $0.lowercased().contains(q) }
                || (task.description ?? "").lowercased().contains(q)
                || (task.acceptanceCriteria ?? "").lowercased().contains(q)
            guard matches else { return false }
        }
        return true
    }
}

/// Sorted union of labels + components actually present on the given tasks.
func availableTaskTags(_ tasks: [EngTask]) -> [String] {
    var seen = Set<String>()
    for task in tasks {
        task.labels?.forEach    { seen.insert($0) }
        task.components?.forEach { seen.insert($0) }
    }
    return seen.sorted()
}
