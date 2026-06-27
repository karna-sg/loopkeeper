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
                        .font(.callout).foregroundStyle(.secondary)
                }
                if loops.isEmpty {
                    ContentUnavailableView("All clear", systemImage: "moon.zzz", description: Text("Nothing you owe is overdue or due today. Good place to stop."))
                } else {
                    ForEach(loops) { loop in
                        VStack(alignment: .leading, spacing: 10) {
                            LoopRow(loop: loop)
                            HStack(spacing: 8) {
                                Button { Task { await model.markDone(loop) } } label: { Label("Done", systemImage: "checkmark") }.tint(.green)
                                Button { Task { await model.snooze(loop, days: 1) } } label: { Label("Tomorrow", systemImage: "clock") }.tint(.orange)
                                Button(role: .destructive) { Task { await model.dismiss(loop) } } label: { Label("Drop", systemImage: "trash") }
                            }
                            .buttonStyle(.bordered).controlSize(.small)
                        }
                        .padding(.vertical, 2)
                    }
                }
            }
            .navigationTitle("Wind down")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
        }
    }
}
