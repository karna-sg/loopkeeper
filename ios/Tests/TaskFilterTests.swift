import XCTest
@testable import Loopkeeper

final class TaskFilterTests: XCTestCase {

    // MARK: helpers

    private func makeTask(
        id: String = UUID().uuidString,
        stage: String = "dev",
        status: String = "in_progress",
        labels: [String]? = nil,
        components: [String]? = nil
    ) -> EngTask {
        EngTask(
            id: id,
            jiraKey: "LP-\(id)",
            jiraUrl: nil,
            title: "Task \(id)",
            description: nil,
            acceptanceCriteria: nil,
            labels: labels,
            components: components,
            jiraStatus: nil,
            repo: nil,
            branch: nil,
            stage: stage,
            status: status,
            artifacts: nil,
            budget: nil,
            claudeModel: nil,
            lastError: nil,
            updatedTs: nil
        )
    }

    // MARK: no-op when inactive

    func testNoFilterPassesAll() {
        let tasks = [makeTask(stage: "dev"), makeTask(stage: "pr"), makeTask(stage: "review")]
        let result = applyTaskFilters(tasks, filter: TaskFilterState())
        XCTAssertEqual(result.count, 3)
    }

    // MARK: stage filter

    func testStageFilterMatchesExact() {
        let tasks = [makeTask(stage: "dev"), makeTask(stage: "pr"), makeTask(stage: "dev")]
        let result = applyTaskFilters(tasks, filter: TaskFilterState(stage: "dev"))
        XCTAssertEqual(result.count, 2)
        XCTAssertTrue(result.allSatisfy { $0.stage == "dev" })
    }

    func testStageFilterAllPassesEverything() {
        let tasks = [makeTask(stage: "dev"), makeTask(stage: "pr")]
        let result = applyTaskFilters(tasks, filter: TaskFilterState(stage: "all"))
        XCTAssertEqual(result.count, 2)
    }

    func testStageFilterNoMatch() {
        let tasks = [makeTask(stage: "dev"), makeTask(stage: "pr")]
        let result = applyTaskFilters(tasks, filter: TaskFilterState(stage: "deploy"))
        XCTAssertTrue(result.isEmpty)
    }

    // MARK: status group filter

    func testStatusGroupNeedsYou() {
        let blocked  = makeTask(status: "blocked")               // needsAction = true
        let running  = makeTask(status: "in_progress")           // needsAction = false, isRunning = true
        let quiet    = makeTask(stage: "dev", status: "queued")
        let tasks = [blocked, running, quiet]
        let result = applyTaskFilters(tasks, filter: TaskFilterState(statusGroup: "needs-you"))
        XCTAssertEqual(result, [blocked])
    }

    func testStatusGroupRunning() {
        let running1 = makeTask(status: "in_progress")
        let running2 = makeTask(status: "deploying")
        let quiet    = makeTask(status: "queued")
        let tasks = [running1, running2, quiet]
        let result = applyTaskFilters(tasks, filter: TaskFilterState(statusGroup: "running"))
        XCTAssertEqual(Set(result.map(\.id)), Set([running1.id, running2.id]))
    }

    func testStatusGroupBlocked() {
        let blocked = makeTask(status: "blocked")
        let other   = makeTask(status: "in_progress")
        let result  = applyTaskFilters([blocked, other], filter: TaskFilterState(statusGroup: "blocked"))
        XCTAssertEqual(result, [blocked])
    }

    func testStatusGroupDoneExcludesActiveAndBlocked() {
        let blocked = makeTask(status: "blocked")
        let running = makeTask(status: "in_progress")
        // needsAction = true for "pr:proposed"
        let pendingPR = makeTask(stage: "pr", status: "proposed")
        let done      = makeTask(stage: "dev", status: "queued")   // quiet: !needsAction, !isRunning, !blocked
        let result = applyTaskFilters([blocked, running, pendingPR, done], filter: TaskFilterState(statusGroup: "done"))
        XCTAssertEqual(result, [done])
    }

    func testStatusGroupAnyPassesAll() {
        let tasks = [makeTask(status: "blocked"), makeTask(status: "in_progress"), makeTask(status: "queued")]
        let result = applyTaskFilters(tasks, filter: TaskFilterState(statusGroup: "any"))
        XCTAssertEqual(result.count, 3)
    }

    // MARK: tag filter

    func testTagFilterMatchesLabel() {
        let tagged   = makeTask(labels: ["mobile-ux", "ios"])
        let untagged = makeTask(labels: ["backend"])
        let result = applyTaskFilters([tagged, untagged], filter: TaskFilterState(tags: ["mobile-ux"]))
        XCTAssertEqual(result, [tagged])
    }

    func testTagFilterMatchesComponent() {
        let t1 = makeTask(components: ["ios/Sources/ContentView.swift"])
        let t2 = makeTask(components: ["backend/routes.py"])
        let result = applyTaskFilters([t1, t2], filter: TaskFilterState(tags: ["ios/Sources/ContentView.swift"]))
        XCTAssertEqual(result, [t1])
    }

    func testTagFilterIsOrAcrossSelectedTags() {
        let a = makeTask(labels: ["alpha"])
        let b = makeTask(labels: ["beta"])
        let c = makeTask(labels: ["gamma"])
        let result = applyTaskFilters([a, b, c], filter: TaskFilterState(tags: ["alpha", "beta"]))
        XCTAssertEqual(Set(result.map(\.id)), Set([a.id, b.id]))
    }

    func testTagFilterEmptyTagsPassesAll() {
        let tasks = [makeTask(labels: ["alpha"]), makeTask()]
        let result = applyTaskFilters(tasks, filter: TaskFilterState(tags: []))
        XCTAssertEqual(result.count, 2)
    }

    func testTagFilterNilLabelsAndComponents() {
        let t = makeTask(labels: nil, components: nil)
        let result = applyTaskFilters([t], filter: TaskFilterState(tags: ["anything"]))
        XCTAssertTrue(result.isEmpty)
    }

    // MARK: AND combination

    func testCombinesStageAndStatusWithAnd() {
        let devRunning = makeTask(stage: "dev", status: "in_progress")
        let devQuiet   = makeTask(stage: "dev", status: "queued")
        let prRunning  = makeTask(stage: "pr",  status: "in_progress")
        let filter = TaskFilterState(stage: "dev", statusGroup: "running")
        let result = applyTaskFilters([devRunning, devQuiet, prRunning], filter: filter)
        XCTAssertEqual(result, [devRunning])
    }

    func testCombinesStageAndTagWithAnd() {
        let devTagged   = makeTask(stage: "dev", labels: ["ios"])
        let devUntagged = makeTask(stage: "dev", labels: ["backend"])
        let prTagged    = makeTask(stage: "pr",  labels: ["ios"])
        let filter = TaskFilterState(stage: "dev", tags: ["ios"])
        let result = applyTaskFilters([devTagged, devUntagged, prTagged], filter: filter)
        XCTAssertEqual(result, [devTagged])
    }

    // MARK: availableTaskTags

    func testAvailableTagsUnionAndSorted() {
        let tasks = [
            makeTask(labels: ["ios", "mobile-ux"], components: ["ContentView.swift"]),
            makeTask(labels: ["backend"],           components: ["ContentView.swift"]),
            makeTask(labels: nil,                   components: nil),
        ]
        let tags = availableTaskTags(tasks)
        XCTAssertEqual(tags, ["ContentView.swift", "backend", "ios", "mobile-ux"])
    }

    func testAvailableTagsEmptyWhenNoTasks() {
        XCTAssertTrue(availableTaskTags([]).isEmpty)
    }

    // MARK: TaskFilterState helpers

    func testIsActiveDefault() {
        XCTAssertFalse(TaskFilterState().isActive)
    }

    func testIsActiveWhenStageSet() {
        XCTAssertTrue(TaskFilterState(stage: "dev").isActive)
    }

    func testIsActiveWhenStatusGroupSet() {
        XCTAssertTrue(TaskFilterState(statusGroup: "running").isActive)
    }

    func testIsActiveWhenTagsSet() {
        XCTAssertTrue(TaskFilterState(tags: ["ios"]).isActive)
    }

    func testActiveCount() {
        var f = TaskFilterState(stage: "dev", statusGroup: "running", tags: ["ios", "mobile-ux"])
        XCTAssertEqual(f.activeCount, 4)
        f.stage = "all"
        XCTAssertEqual(f.activeCount, 3)
    }

    // activeCount == 1 drives singular "1 filter active" in the VoiceOver label
    func testActiveCountSingleFilter() {
        XCTAssertEqual(TaskFilterState(stage: "dev").activeCount, 1)
        XCTAssertEqual(TaskFilterState(statusGroup: "blocked").activeCount, 1)
        XCTAssertEqual(TaskFilterState(tags: ["ios"]).activeCount, 1)
    }

    // Each tag counts individually toward activeCount
    func testActiveCountMultipleTags() {
        let f = TaskFilterState(tags: ["ios", "backend", "mobile-ux"])
        XCTAssertEqual(f.activeCount, 3)
    }

    func testIsActiveReturnsFalseAfterReset() {
        var f = TaskFilterState(stage: "dev", statusGroup: "running", tags: ["ios"])
        XCTAssertTrue(f.isActive)
        f.stage = "all"
        f.statusGroup = "any"
        f.tags = []
        XCTAssertFalse(f.isActive)
        XCTAssertEqual(f.activeCount, 0)
    }
}
