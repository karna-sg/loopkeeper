import SwiftUI

/// A "My Jira Tasks" row — mirrors LoopRow (leading accent bar, glyph, two-line text, trailing badge).
struct JiraTaskRow: View {
    let task: EngTask

    var body: some View {
        HStack(spacing: 10) {
            RoundedRectangle(cornerRadius: 1.5)
                .fill(Theme.stageAccent(task.status))
                .frame(width: 3)
                .frame(maxHeight: .infinity)
            Image(systemName: Theme.stageIcon(task.stage))
                .foregroundStyle(Theme.secondary)
                .frame(width: 20)
            VStack(alignment: .leading, spacing: 3) {
                Text(task.title).lineLimit(2)
                HStack(spacing: 5) {
                    Text(task.jiraKey).monospaced().foregroundStyle(.secondary)
                    Text("·").foregroundStyle(.tertiary)
                    Text("\(Theme.stageTitle(task.stage)) — \(Theme.statusLabel(task.stage, task.status))")
                        .foregroundStyle(.secondary)
                }
                .font(.subheadline)
                .lineLimit(1)
            }
            Spacer(minLength: 8)
            badge
        }
        .padding(.vertical, 2)
    }

    @ViewBuilder private var badge: some View {
        if task.needsAction {
            Text("Action")
                .font(.caption.weight(.semibold))
                .padding(.horizontal, 8).padding(.vertical, 3)
                .background(Color.orange.opacity(0.18), in: Capsule())
                .foregroundStyle(.orange)
        } else if task.isRunning {
            ProgressView().controlSize(.small)
        } else {
            Text(Theme.stageTitle(task.stage))
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}
