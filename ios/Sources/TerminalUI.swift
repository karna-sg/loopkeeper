import SwiftUI

// MARK: - Font scale

extension Font {
    /// 13pt monospaced — terminal body text.
    static let mono = Font.system(size: 13, design: .monospaced)
    /// 13pt monospaced medium weight — `[ action ]` buttons.
    static let monoMed = Font.system(size: 13, weight: .medium, design: .monospaced)
    /// 11pt monospaced — secondary/metadata lines.
    static let monoSmall = Font.system(size: 11, design: .monospaced)
    /// 12pt semibold monospaced — `# section` headers.
    static let monoHdr = Font.system(size: 12, weight: .semibold, design: .monospaced)
}

// MARK: - Shared views

/// `# section_name` header in the terminal teal accent. Pass the full title string (e.g. `"# shipped"`).
struct TerminalSectionHeader: View {
    let title: String
    init(_ title: String) { self.title = title }
    var body: some View {
        Text(title)
            .font(.monoHdr)
            .foregroundStyle(Theme.headerAccent)
            .textCase(nil)
    }
}

/// A key / value stat row: label in secondary, value in primary. Pass `valueTint` for
/// conditional coloring (e.g. `.red` when a count is > 0).
struct TerminalStatRow: View {
    let label: String
    let value: String
    var valueTint: Color = .primary

    var body: some View {
        HStack {
            Text(label).font(.mono).foregroundStyle(.secondary)
            Spacer()
            Text(value).font(.mono).foregroundStyle(valueTint)
        }
    }
}

/// A horizontal bar-chart row used by both InsightsView and EngInsightsView.
/// `peak` is the maximum value in the series (computed once by the caller).
struct TerminalBarRow: View {
    let label: String
    let value: Int
    let peak: Int

    var body: some View {
        HStack(spacing: 8) {
            Text(label)
                .font(.monoSmall)
                .foregroundStyle(.secondary)
                .frame(width: 78, alignment: .leading)
            GeometryReader { geo in
                Capsule()
                    .fill(Theme.headerAccent.opacity(0.75))
                    .frame(width: max(6, geo.size.width * CGFloat(value) / CGFloat(max(peak, 1))))
            }
            .frame(height: 8)
            Text("\(value)")
                .font(.monoSmall)
                .foregroundStyle(.secondary)
        }
    }
}

/// `[ label ]` plain-mono action button. Wrap async calls in a `Task { }` in the action closure.
struct TerminalActionButton: View {
    let title: String
    var tint: Color = Theme.headerAccent
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text("[ \(title) ]")
                .font(.monoMed)
                .foregroundStyle(tint)
        }
        .buttonStyle(.plain)
    }
}

/// `[ done ]` dismiss button for toolbar use. Place inside a `ToolbarItem`.
struct TerminalDoneButton: View {
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Text("[ done ]")
                .font(.mono)
                .foregroundStyle(Theme.headerAccent)
        }
        .buttonStyle(.plain)
    }
}

// MARK: - View modifier

private struct TerminalListBackground: ViewModifier {
    func body(content: Content) -> some View {
        content
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(Theme.terminalBG.ignoresSafeArea())
    }
}

extension View {
    /// Applies the terminal background to a `List`: plain style, hidden default background,
    /// `Theme.terminalBG` fill extending under the safe area.
    func terminalListBackground() -> some View {
        modifier(TerminalListBackground())
    }
}
