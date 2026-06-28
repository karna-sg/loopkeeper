import SwiftUI

/// Live monospaced activity feed — tool calls, text blocks, and result lines from the agent's JSONL log.
/// The parent owns `lines` (accumulated across polls) and `done`; this view renders and auto-scrolls.
struct ActivityFeedView: View {
    let lines: [String]
    let done: Bool

    private let mono = Font.system(size: 12, design: .monospaced)
    private let monoSmall = Font.system(size: 11, design: .monospaced)
    private let bottomID = "activity_bottom"

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text("# activity")
                    .font(.system(size: 11, weight: .semibold, design: .monospaced))
                    .foregroundStyle(Theme.headerAccent)
                if !done {
                    ProgressView()
                        .controlSize(.mini)
                        .tint(.secondary)
                }
                Spacer(minLength: 0)
            }

            if lines.isEmpty && !done {
                Text("waiting for agent output…")
                    .font(monoSmall)
                    .foregroundStyle(.tertiary)
            } else if !lines.isEmpty {
                ScrollViewReader { proxy in
                    ScrollView(.vertical, showsIndicators: false) {
                        LazyVStack(alignment: .leading, spacing: 2) {
                            ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                                Text(line)
                                    .font(mono)
                                    .foregroundStyle(lineColor(line))
                                    .textSelection(.enabled)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            Color.clear.frame(height: 1).id(bottomID)
                        }
                        .padding(.horizontal, 2)
                    }
                    .frame(maxHeight: 320)
                    .onChange(of: lines.count) { _, _ in
                        withAnimation(.easeOut(duration: 0.15)) {
                            proxy.scrollTo(bottomID, anchor: .bottom)
                        }
                    }
                }
            }

            if done && !lines.isEmpty {
                Text("— run complete —")
                    .font(monoSmall)
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.vertical, 10)
        .padding(.horizontal, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(
            RoundedRectangle(cornerRadius: 6)
                .stroke(Color.secondary.opacity(0.15), lineWidth: 1)
        )
    }

    private func lineColor(_ line: String) -> Color {
        if line.hasPrefix("tool:") { return .blue.opacity(0.85) }
        if line.hasPrefix("result: ok") { return Theme.mdStrong }
        if line.hasPrefix("result: error") { return .red }
        return .primary
    }
}
