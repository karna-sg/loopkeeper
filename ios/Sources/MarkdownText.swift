import SwiftUI

/// Renders markdown source as clean, readable, COLOR-coded monospaced text — no raw `#`, `**`,
/// backticks, `-` bullets, `---` rules or `| tables |` shown literally.
///
/// - Headings → bold, colored (Theme.mdHeading)
/// - **bold** → Theme.mdStrong, *italic* → italic, `code` → Theme.mdCode
/// - `- / * / 1.` lists → `•` bullets (dim marker)
/// - `> quote` → `┃` bar, secondary text
/// - `---` → a thin divider rule
/// - `| a | b |` tables → aligned rows in a faint code block
/// - ``` fences → verbatim code block (warm, boxed)
///
/// Pure presentation: parses line-by-line so any odd backend text degrades to plain text rather than
/// failing. Long content wraps and scrolls with the parent (nothing truncated).
struct MarkdownText: View {
    let source: String
    var size: CGFloat = 13
    var color: Color = .primary

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                block.view(size: size, color: color)
            }
        }
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var blocks: [Block] { Self.parse(source) }

    // MARK: blocks

    private enum Block {
        case heading(String, level: Int)
        case bullet(String)
        case quote(String)
        case code(String)          // a fenced ``` block, shown verbatim
        case table([[String]])     // rows of cells (header row first)
        case rule
        case paragraph(String)
        case spacer

        @ViewBuilder func view(size: CGFloat, color: Color) -> some View {
            switch self {
            case let .heading(t, level):
                MarkdownText.inlineText(t, base: Theme.mdHeading)
                    .font(.system(size: level <= 1 ? size + 2 : size + 1, weight: .bold, design: .monospaced))
                    .foregroundStyle(Theme.mdHeading)
                    .padding(.top, 5)
            case let .bullet(t):
                HStack(alignment: .firstTextBaseline, spacing: 7) {
                    Text("•").font(.system(size: size, design: .monospaced)).foregroundStyle(Theme.headerAccent)
                    MarkdownText.inlineText(t, base: color)
                        .font(.system(size: size, design: .monospaced))
                        .foregroundStyle(color)
                }
                .padding(.leading, 4)
            case let .quote(t):
                HStack(alignment: .firstTextBaseline, spacing: 7) {
                    Rectangle().fill(Theme.headerAccent.opacity(0.6)).frame(width: 2)
                    MarkdownText.inlineText(t, base: .secondary)
                        .font(.system(size: size, design: .monospaced))
                        .foregroundStyle(.secondary)
                }
                .fixedSize(horizontal: false, vertical: true)
            case let .code(t):
                Text(t)
                    .font(.system(size: size - 1, design: .monospaced))
                    .foregroundStyle(Theme.mdCode)
                    .padding(9)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.mdCode.opacity(0.10), in: RoundedRectangle(cornerRadius: 5))
            case let .table(rows):
                tableView(rows, size: size)
            case .rule:
                Rectangle().fill(Color.secondary.opacity(0.25)).frame(height: 1).padding(.vertical, 4)
            case let .paragraph(t):
                MarkdownText.inlineText(t, base: color)
                    .font(.system(size: size, design: .monospaced))
                    .foregroundStyle(color)
            case .spacer:
                Color.clear.frame(height: 4)
            }
        }

        /// A markdown table → monospaced, padded columns inside a faint box. Header row in heading
        /// color. Cells are stripped of inline markers (`` ` ``, `**`) so nothing raw shows and the
        /// column widths align on the cleaned text.
        @ViewBuilder private func tableView(_ rows: [[String]], size: CGFloat) -> some View {
            let clean = rows.map { $0.map(MarkdownText.plainInline) }
            let cols = clean.map(\.count).max() ?? 0
            let widths: [Int] = (0..<cols).map { c in
                clean.map { c < $0.count ? $0[c].count : 0 }.max() ?? 0
            }
            VStack(alignment: .leading, spacing: 2) {
                ForEach(Array(clean.enumerated()), id: \.offset) { idx, row in
                    let line = (0..<cols).map { c -> String in
                        let cell = c < row.count ? row[c] : ""
                        return cell.padding(toLength: max(widths[c], cell.count), withPad: " ", startingAt: 0)
                    }.joined(separator: "  ")
                    Text(line)
                        .font(.system(size: size - 1, weight: idx == 0 ? .bold : .regular, design: .monospaced))
                        .foregroundStyle(idx == 0 ? Theme.mdHeading : Color.primary)
                }
            }
            .padding(9)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.secondary.opacity(0.07), in: RoundedRectangle(cornerRadius: 5))
        }
    }

    /// Strip inline markers to a plain string (used for table cells / width measurement).
    nonisolated static func plainInline(_ line: String) -> String {
        var out = ""
        var rest = Substring(line)
        while let token = nextToken(in: rest) {
            out += String(token.before)
            out += token.content
            rest = token.after
        }
        out += rest
        return out
    }

    // MARK: inline spans

    /// Build an inline-styled, colored `Text` from a single line. `**bold**` → mdStrong, `` `code` ``
    /// → mdCode, `*italic*` → italic. `base` is the surrounding text color (so plain runs match).
    static func inlineText(_ line: String, base: Color) -> Text {
        var result = Text("")
        var rest = Substring(line)
        while let token = nextToken(in: rest) {
            if !token.before.isEmpty { result = result + Text(String(token.before)).foregroundColor(base) }
            switch token.style {
            case .bold:   result = result + Text(token.content).bold().foregroundColor(Theme.mdStrong)
            case .italic: result = result + Text(token.content).italic().foregroundColor(base)
            case .code:   result = result + Text(token.content).foregroundColor(Theme.mdCode)
            }
            rest = token.after
        }
        if !rest.isEmpty { result = result + Text(String(rest)).foregroundColor(base) }
        return result
    }

    private enum Style { case bold, italic, code }
    private struct Token { let before: Substring; let style: Style; let content: String; let after: Substring }

    /// Find the first `**…**`, `*…*`/`_…_`, or `` `…` `` span; nil when none remain.
    nonisolated private static func nextToken(in s: Substring) -> Token? {
        let markers: [(open: String, close: String, style: Style)] = [
            ("**", "**", .bold), ("__", "__", .bold),
            ("`", "`", .code),
            ("*", "*", .italic), ("_", "_", .italic),
        ]
        var best: (range: Range<Substring.Index>, content: String, style: Style)?
        for m in markers {
            guard let openR = s.range(of: m.open) else { continue }
            let afterOpen = openR.upperBound
            guard afterOpen < s.endIndex,
                  let closeR = s.range(of: m.close, range: afterOpen..<s.endIndex),
                  closeR.lowerBound > afterOpen else { continue }
            let content = String(s[afterOpen..<closeR.lowerBound])
            if content.isEmpty { continue }
            let full = openR.lowerBound..<closeR.upperBound
            if best == nil || full.lowerBound < best!.range.lowerBound {
                best = (full, content, m.style)
            }
        }
        guard let b = best else { return nil }
        return Token(before: s[s.startIndex..<b.range.lowerBound], style: b.style,
                     content: b.content, after: s[b.range.upperBound...])
    }

    // MARK: block parsing

    /// Split source into blocks: fenced code, tables, rules, headings, lists, quotes, paragraphs.
    private static func parse(_ source: String) -> [Block] {
        var blocks: [Block] = []
        let lines = source.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
        var i = 0
        while i < lines.count {
            let raw = lines[i]
            let trimmed = raw.trimmingCharacters(in: .whitespaces)

            // fenced code block ```
            if trimmed.hasPrefix("```") {
                var code: [String] = []
                i += 1
                while i < lines.count, !lines[i].trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                    code.append(lines[i]); i += 1
                }
                i += 1 // consume closing fence
                blocks.append(.code(code.joined(separator: "\n")))
                continue
            }

            // table: a run of lines that look like `| a | b |`
            if isTableRow(trimmed) {
                var rows: [[String]] = []
                while i < lines.count, isTableRow(lines[i].trimmingCharacters(in: .whitespaces)) {
                    let cells = tableCells(lines[i].trimmingCharacters(in: .whitespaces))
                    if !isTableSeparator(cells) { rows.append(cells) }
                    i += 1
                }
                if !rows.isEmpty { blocks.append(.table(rows)) }
                continue
            }

            if trimmed.isEmpty {
                blocks.append(.spacer)
            } else if isRule(trimmed) {
                blocks.append(.rule)
            } else if trimmed.hasPrefix("#") {
                let hashes = trimmed.prefix { $0 == "#" }.count
                blocks.append(.heading(strip(trimmed.dropFirst(hashes)), level: hashes))
            } else if trimmed.hasPrefix("> ") || trimmed == ">" {
                blocks.append(.quote(strip(trimmed.dropFirst(1))))
            } else if let m = bulletContent(trimmed) {
                blocks.append(.bullet(m))
            } else {
                blocks.append(.paragraph(strip(Substring(trimmed))))
            }
            i += 1
        }
        // collapse runs of spacers so we don't get big gaps
        return blocks.reduce(into: [Block]()) { acc, b in
            if case .spacer = b, case .spacer = acc.last { return }
            acc.append(b)
        }
    }

    /// `---` / `***` / `___` (3+ of the same) → horizontal rule.
    private static func isRule(_ line: String) -> Bool {
        guard line.count >= 3 else { return false }
        for ch in ["-", "*", "_"] where line.allSatisfy({ String($0) == ch }) { return true }
        return false
    }

    private static func isTableRow(_ line: String) -> Bool {
        line.hasPrefix("|") && line.dropFirst().contains("|")
    }

    /// "| a | b |" → ["a", "b"] (trimmed, outer pipes removed).
    private static func tableCells(_ line: String) -> [String] {
        var s = Substring(line)
        if s.hasPrefix("|") { s = s.dropFirst() }
        if s.hasSuffix("|") { s = s.dropLast() }
        return s.split(separator: "|", omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespaces) }
    }

    /// A `|---|:--:|` alignment row — drop it from rendered rows.
    private static func isTableSeparator(_ cells: [String]) -> Bool {
        !cells.isEmpty && cells.allSatisfy { c in
            !c.isEmpty && c.allSatisfy { $0 == "-" || $0 == ":" || $0 == " " }
        }
    }

    /// `- x` / `* x` / `+ x` / `1. x` → "x" (the bullet content); nil when not a list item.
    private static func bulletContent(_ line: String) -> String? {
        for p in ["- ", "* ", "+ "] where line.hasPrefix(p) {
            return strip(Substring(line.dropFirst(p.count)))
        }
        // ordered list: "12. text"
        let scalars = Array(line)
        var idx = 0
        while idx < scalars.count, scalars[idx].isNumber { idx += 1 }
        if idx > 0, idx + 1 < scalars.count, scalars[idx] == ".", scalars[idx + 1] == " " {
            return strip(Substring(String(scalars[(idx + 2)...])))
        }
        return nil
    }

    private static func strip(_ s: Substring) -> String {
        s.trimmingCharacters(in: .whitespaces)
    }
}
