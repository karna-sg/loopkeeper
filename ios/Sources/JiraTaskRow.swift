import SwiftUI

/// A "My Jira Tasks" row, terminal-clean: one dense monospaced line —
///
///     ● LK-4   plan      awaiting
///       Wire up the retry queue for failed deploys
///       [P0] [backend]
///
/// The leading glyph is the only color (dim dot = needs you, neutral otherwise). Label chips
/// appear below the title when any LoopKeeper labels are attached.
struct JiraTaskRow: View {
    let task: EngTask
    /// Label catalog passed in from the parent so the row can resolve ids → names/colors.
    var labels: [EngLabel] = []

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
            if !attachedLabels.isEmpty {
                HStack(spacing: 4) {
                    ForEach(attachedLabels) { lbl in
                        Text(lbl.name)
                            .font(.system(size: 10, design: .monospaced))
                            .padding(.horizontal, 5).padding(.vertical, 2)
                            .background(Theme.labelColor(lbl.color).opacity(0.20))
                            .foregroundStyle(Theme.labelColor(lbl.color))
                            .clipShape(RoundedRectangle(cornerRadius: 3))
                    }
                }
                .padding(.leading, 17)
            }
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

    private var attachedLabels: [EngLabel] {
        guard let ids = task.labelIds, !ids.isEmpty else { return [] }
        let catalog = Dictionary(uniqueKeysWithValues: labels.map { ($0.id, $0) })
        return ids.compactMap { catalog[$0] }
    }
}
