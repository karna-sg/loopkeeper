import SwiftUI

/// Renders markdown source as clean, readable monospaced text — no raw `#`, `**`, backticks or
/// `-` bullets shown literally. Headings become bold lines, `**bold**`/`*italic*`/`` `code` `` render
/// inline, list items get a `•`, blockquotes a `┃`. Fenced ``` blocks are shown verbatim as code.
///
/// Pure presentation: parses line-by-line so any odd backend text degrades to plain text rather than
/// failing. Long content wraps and scrolls with the parent (nothing truncated).
struct MarkdownText: View {
    let source: String
    var size: CGFloat = 13
    var color: Color = .primary

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                block.view(size: size, color: color)
            }
        }
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var blocks: [Block] { Self.parse(source) }

    // MARK: parsing

    private enum Block {
        case heading(String, level: Int)
        case bullet(String)
        case quote(String)
        case code(String)          // a fenced ``` block, shown verbatim
        case paragraph(String)
        case spacer

        @ViewBuilder func view(size: CGFloat, color: Color) -> some View {
            switch self {
            case let .heading(t, level):
                inline(t, size: level <= 1 ? size + 2 : size + 1, weight: .bold, color: color)
                    .padding(.top, 4)
            case let .bullet(t):
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text("•").font(.system(size: size, design: .monospaced)).foregroundStyle(.secondary)
                    inline(t, size: size, weight: .regular, color: color)
                }
                .padding(.leading, 4)
            case let .quote(t):
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text("┃").font(.system(size: size, design: .monospaced)).foregroundStyle(.secondary)
                    inline(t, size: size, weight: .regular, color: .secondary)
                }
            case let .code(t):
                Text(t)
                    .font(.system(size: size - 1, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.secondary.opacity(0.10), in: RoundedRectangle(cornerRadius: 4))
            case let .paragraph(t):
                inline(t, size: size, weight: .regular, color: color)
            case .spacer:
                Color.clear.frame(height: 4)
            }
        }

        /// Render one line's inline spans (`**bold**`, `*italic*`, `` `code` ``) as styled mono text.
        @ViewBuilder private func inline(_ line: String, size: CGFloat, weight: Font.Weight, color: Color) -> some View {
            MarkdownText.inlineText(line)
                .font(.system(size: size, weight: weight, design: .monospaced))
                .foregroundStyle(color)
        }
    }

    /// Build an inline-styled `Text` from a single line, stripping `**`, `*`/`_`, and `` ` ``.
    static func inlineText(_ line: String) -> Text {
        var result = Text("")
        var rest = Substring(line)
        while let token = nextToken(in: rest) {
            if !token.before.isEmpty { result = result + Text(String(token.before)) }
            switch token.style {
            case .bold:   result = result + Text(token.content).bold()
            case .italic: result = result + Text(token.content).italic()
            case .code:   result = result + Text(token.content).font(.system(.body, design: .monospaced))
            }
            rest = token.after
        }
        if !rest.isEmpty { result = result + Text(String(rest)) }
        return result
    }

    private enum Style { case bold, italic, code }
    private struct Token { let before: Substring; let style: Style; let content: String; let after: Substring }

    /// Find the first `**…**`, `*…*`/`_…_`, or `` `…` `` span; nil when none remain.
    private static func nextToken(in s: Substring) -> Token? {
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

    /// Split source into blocks, pulling out fenced code and classifying each line.
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

            if trimmed.isEmpty {
                blocks.append(.spacer)
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

    /// Trim and drop a stray trailing/leading whitespace from a heading/line fragment.
    private static func strip(_ s: Substring) -> String {
        s.trimmingCharacters(in: .whitespaces)
    }
}
