import Foundation

/// Returns the loops to display in the "No date" section.
/// When collapsed (not expanded) and the total exceeds `limit`, only the first `limit` are returned.
func noDateVisible(_ loops: [OpenLoop], expanded: Bool, limit: Int = 10) -> [OpenLoop] {
    guard !expanded, loops.count > limit else { return loops }
    return Array(loops.prefix(limit))
}
