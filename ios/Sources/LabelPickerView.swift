import SwiftUI

/// Multi-select label picker for a task. Toggling a label attaches or detaches it.
/// Opened via swipe action on a task row (← "Labels").
struct LabelPickerView: View {
    let task: EngTask
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                if model.labels.isEmpty {
                    ContentUnavailableView(
                        "No labels yet",
                        systemImage: "tag",
                        description: Text("Create labels from ⋯ → Manage labels, then attach them here.")
                    )
                    .background(Theme.terminalBG.ignoresSafeArea())
                } else {
                    List {
                        ForEach(model.labels) { lbl in
                            let attached = task.labelIds?.contains(lbl.id) ?? false
                            Button {
                                Haptics.tap()
                                if attached {
                                    Task { await model.detachLabel(task: task, labelId: lbl.id) }
                                } else {
                                    Task { await model.attachLabel(task: task, labelId: lbl.id) }
                                }
                                dismiss()
                            } label: {
                                HStack(spacing: 10) {
                                    Circle()
                                        .fill(Theme.labelColor(lbl.color))
                                        .frame(width: 12, height: 12)
                                    Text(lbl.name)
                                        .font(.mono)
                                        .foregroundStyle(.primary)
                                    Spacer()
                                    if attached {
                                        Image(systemName: "checkmark")
                                            .foregroundStyle(Theme.labelColor(lbl.color))
                                    }
                                }
                            }
                            .buttonStyle(.plain)
                        }
                        .listRowBackground(Color.clear)
                    }
                    .terminalListBackground()
                }
            }
            .navigationTitle("labels — \(task.jiraKey)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    TerminalDoneButton { dismiss() }
                }
            }
        }
    }
}
