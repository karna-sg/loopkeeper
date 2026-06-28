import SwiftUI

/// A "My Jira Tasks" row, terminal-clean: one dense monospaced line —
///
///     ● LK-4   plan      awaiting
///       Wire up the retry queue for failed deploys
///
/// The leading glyph is the only color (dim dot = needs you, neutral otherwise). No capsule
/// badge, no card. Hierarchy comes from weight + indent, not size or chrome.
struct JiraTaskRow: View {
    let task: EngTask

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 8) {
                Text(glyph)
                    .font(.system(size: 13, design: .monospaced))
                    .foregroundStyle(glyphTint)
                    .frame(width: 9, alignment: .center)
                Text(task.jiraKey)
                    .font(.system(size: 13, weight: .semibold, design: .monospaced))
                Text(Theme.stageKey(task.stage))
                    .font(.system(size: 13, design: .monospaced))
                    .foregroundStyle(.secondary)
                Text(Theme.statusToken(task.stage, task.status))
                    .font(.system(size: 13, design: .monospaced))
                    .foregroundStyle(Theme.tickTint(task.status))
                Spacer(minLength: 6)
                if task.isRunning {
                    ProgressView().controlSize(.mini)
                }
            }
            Text(task.title)
                .font(.system(size: 13, design: .monospaced))
                .foregroundStyle(.primary)
                .lineLimit(2)
                .padding(.leading, 17)
        }
        .padding(.vertical, 3)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(task.jiraKey), \(task.title), \(Theme.stageTitle(task.stage)) \(Theme.statusLabel(task.stage, task.status))")
    }

    /// `●` when waiting on a human, otherwise the stage's terminal glyph.
    private var glyph: String {
        task.needsAction ? "●" : Theme.stageGlyph(task.status)
    }

    private var glyphTint: Color {
        Theme.tickTint(task.status)
    }
}
