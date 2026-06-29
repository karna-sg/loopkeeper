import Foundation

/// Persisted filter dimensions for the engineering task list.
/// Stage/statusGroup/tags combine with AND; within tags it's OR.
struct TaskFilterState {
    var stage: String = "all"
    var statusGroup: String = "any"
    var tags: Set<String> = []

    var isActive: Bool {
        stage != "all" || statusGroup != "any" || !tags.isEmpty
    }

    var activeCount: Int {
        (stage != "all" ? 1 : 0) + (statusGroup != "any" ? 1 : 0) + tags.count
    }
}

/// Pure filter: stage "all" / statusGroup "any" / empty tags → passes everything through.
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
        guard !filter.tags.isEmpty else { return true }
        let taskTags = Set((task.labels ?? []) + (task.components ?? []))
        return !filter.tags.isDisjoint(with: taskTags)
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
