import XCTest
@testable import Loopkeeper

final class NoDateCapTests: XCTestCase {

    private func makeLoop(id: String = UUID().uuidString) -> OpenLoop {
        OpenLoop(
            id: id,
            direction: "owe",
            kind: "commitment",
            summary: "Test loop \(id)",
            counterpart: "someone",
            channel: "slack",
            permalink: "https://slack.com/archives/C0/p0",
            sourceLabel: nil,
            dueDate: nil,
            dueConfidence: "none",
            firmness: "tentative",
            status: "open",
            tenant: "test",
            snoozedUntil: nil,
            resolution: nil,
            createdTs: nil,
            resolvedTs: nil,
            userLabel: nil,
            quoteExcerpt: nil,
            recurrence: nil,
            snoozeCondition: nil,
            project: nil,
            tags: nil
        )
    }

    private func makeLoops(_ count: Int) -> [OpenLoop] {
        (0..<count).map { makeLoop(id: "loop-\($0)") }
    }

    // MARK: below or at cap — no truncation

    func testFewerThanLimitReturnsAll() {
        XCTAssertEqual(noDateVisible(makeLoops(5), expanded: false).count, 5)
    }

    func testExactlyAtLimitReturnsAll() {
        XCTAssertEqual(noDateVisible(makeLoops(10), expanded: false).count, 10)
    }

    func testEmptyReturnsEmpty() {
        XCTAssertTrue(noDateVisible([], expanded: false).isEmpty)
        XCTAssertTrue(noDateVisible([], expanded: true).isEmpty)
    }

    // MARK: above cap — truncation when collapsed

    func testMoreThanLimitCapsAtTenWhenCollapsed() {
        XCTAssertEqual(noDateVisible(makeLoops(15), expanded: false).count, 10)
    }

    func testCappedLoopsAreFirstN() {
        let loops = makeLoops(15)
        let visible = noDateVisible(loops, expanded: false)
        XCTAssertEqual(visible.map(\.id), Array(loops.prefix(10)).map(\.id))
    }

    // MARK: expanded — show all

    func testExpandedReturnsAll() {
        XCTAssertEqual(noDateVisible(makeLoops(15), expanded: true).count, 15)
    }

    func testExpandedPreservesOrder() {
        let loops = makeLoops(15)
        XCTAssertEqual(noDateVisible(loops, expanded: true).map(\.id), loops.map(\.id))
    }

    // MARK: custom limit parameter

    func testCustomLimitTruncates() {
        XCTAssertEqual(noDateVisible(makeLoops(20), expanded: false, limit: 5).count, 5)
    }

    func testCustomLimitExactBoundaryReturnsAll() {
        XCTAssertEqual(noDateVisible(makeLoops(5), expanded: false, limit: 5).count, 5)
    }
}
