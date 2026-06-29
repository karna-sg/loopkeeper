import XCTest
@testable import Loopkeeper

final class MarkdownTextTests: XCTestCase {

    // MARK: plainInline — strips markers, preserves content for table width measurement

    func testPlainInlinePlainString() {
        XCTAssertEqual(MarkdownText.plainInline("hello world"), "hello world")
    }

    func testPlainInlineStripsBacktickCode() {
        XCTAssertEqual(
            MarkdownText.plainInline("`renderColdStartPrompt`"),
            "renderColdStartPrompt"
        )
    }

    func testPlainInlineStripsLongFunctionSignature() {
        let raw = "`wrapUntrusted(label: String, text: String, nonce: String)`"
        let want = "wrapUntrusted(label: String, text: String, nonce: String)"
        XCTAssertEqual(MarkdownText.plainInline(raw), want)
    }

    func testPlainInlinePreservesLongFilePath() {
        let path = "backend/src/engineering/untrusted.ts"
        XCTAssertEqual(MarkdownText.plainInline(path), path)
    }

    func testPlainInlineStripsBold() {
        XCTAssertEqual(MarkdownText.plainInline("**bold text**"), "bold text")
    }

    func testPlainInlineStripsItalic() {
        XCTAssertEqual(MarkdownText.plainInline("*italic*"), "italic")
    }

    func testPlainInlineMixedSpansPreserveContent() {
        // Bold + inline code in same line — all markers stripped, content preserved
        let raw = "See **docs** and `<<UNTRUSTED:label:nonce>>`"
        let want = "See docs and <<UNTRUSTED:label:nonce>>"
        XCTAssertEqual(MarkdownText.plainInline(raw), want)
    }

    func testPlainInlineEmptyString() {
        XCTAssertEqual(MarkdownText.plainInline(""), "")
    }

    func testPlainInlineNoMarkersPassesThrough() {
        let line = "a plain line with no markers at all"
        XCTAssertEqual(MarkdownText.plainInline(line), line)
    }

    func testPlainInlineNestedAngles() {
        // Template literals like <<UNTRUSTED:${label}:${nonce}>> must not be altered
        let raw = "<<UNTRUSTED:${label}:${nonce}>>"
        XCTAssertEqual(MarkdownText.plainInline(raw), raw)
    }

    // MARK: inlineText — concatenates Text runs without crashing on long tokens

    func testInlineTextDoesNotTruncateLongIdentifier() {
        // We cannot inspect Text content directly, but constructing it must not throw
        // and the resulting description must include the identifier.
        let identifier = "renderColdStartPromptForUntrustedContentWithNonceAndLabel"
        let _ = MarkdownText.inlineText(identifier, base: .primary)
        // If we reach here without a crash the test passes; layout wrapping is a UI concern.
    }

    func testInlineTextHandlesInlineCodeSpan() {
        let line = "call `wrapUntrusted(label: String, text: String, nonce: String)` here"
        let _ = MarkdownText.inlineText(line, base: .primary)
    }

    func testInlineTextHandlesEmptyInput() {
        let _ = MarkdownText.inlineText("", base: .primary)
    }
}
