import SwiftUI

/// End-of-day shutdown ritual: a live worklist of everything you OWE that's overdue or due today.
/// Decide each — done, push to tomorrow, or drop — so nothing slides silently into overdue.
struct ShutdownView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    private var loops: [OpenLoop] {
        guard let brief = model.brief else { return [] }
        return (brief.overdue + brief.today).sorted { $0.priorityScore > $1.priorityScore }
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text("Clear the deck before you log off. Decide each one: done, push, or drop.")
                        .font(.mono).foregroundStyle(.secondary)
                }
                .listRowBackground(Color.clear)

                if loops.isEmpty {
                    ContentUnavailableView("All clear", systemImage: "moon.zzz", description: Text("Nothing you owe is overdue or due today. Good place to stop."))
                        .listRowBackground(Color.clear)
                } else {
                    ForEach(loops) { loop in
                        VStack(alignment: .leading, spacing: 10) {
                            LoopRow(loop: loop)
                            HStack(spacing: 16) {
                                TerminalActionButton(title: "done", tint: .green) {
                                    Task { await model.markDone(loop) }
                                }
                                TerminalActionButton(title: "tomorrow", tint: .orange) {
                                    Task { await model.snooze(loop, days: 1) }
                                }
                                TerminalActionButton(title: "drop", tint: .red) {
                                    Task { await model.dismiss(loop) }
                                }
                            }
                        }
                        .padding(.vertical, 2)
                    }
                    .listRowBackground(Color.clear)
                }
            }
            .terminalListBackground()
            .navigationTitle("wind down")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    TerminalDoneButton { dismiss() }
                }
            }
        }
    }
}
