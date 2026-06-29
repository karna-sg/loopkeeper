import SwiftUI

/// A weekly retrospective: celebrate what shipped, clear what's still overdue, and chase what's
/// gone quiet — so the backlog doesn't silently accrete.
struct WeeklyReviewView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var shipped: [OpenLoop] = []
    @State private var loading = true

    private var overdue: [OpenLoop] { model.brief?.overdue ?? [] }

    private var stale: [OpenLoop] {
        let iso = ISO8601DateFormatter()
        let cutoff = Date().addingTimeInterval(-7 * 86_400)
        return (model.brief?.awaiting ?? []).filter { loop in
            guard let ts = loop.createdTs, let d = iso.date(from: ts) else { return true }
            return d < cutoff
        }
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text("Your week in loops. Celebrate what shipped, clear what's overdue, chase what's gone quiet.")
                        .font(.mono).foregroundStyle(.secondary)
                }
                .listRowBackground(Color.clear)

                Section {
                    if loading {
                        ProgressView()
                    } else if shipped.isEmpty {
                        Text("Nothing closed in the last 7 days.")
                            .font(.mono).foregroundStyle(.secondary)
                    } else {
                        ForEach(shipped) { loop in
                            HStack(spacing: 8) {
                                Text("✓").font(.mono).foregroundStyle(.green)
                                Text(loop.summary).font(.mono).lineLimit(2)
                            }
                        }
                    }
                } header: {
                    TerminalSectionHeader("# shipped_this_week  \(shipped.count)")
                }
                .listRowBackground(Color.clear)

                if !overdue.isEmpty {
                    Section {
                        ForEach(overdue) { loop in actionRow(loop) }
                    } header: {
                        TerminalSectionHeader("# still_overdue  \(overdue.count)")
                    }
                    .listRowBackground(Color.clear)
                }

                if !stale.isEmpty {
                    Section {
                        ForEach(stale) { loop in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(loop.summary).font(.mono).lineLimit(2)
                                if !loop.counterpart.isEmpty {
                                    Text("waiting on \(loop.counterpart)")
                                        .font(.monoSmall).foregroundStyle(.secondary)
                                }
                            }
                        }
                    } header: {
                        TerminalSectionHeader("# waiting_too_long  \(stale.count)")
                    }
                    .listRowBackground(Color.clear)
                }
            }
            .terminalListBackground()
            .navigationTitle("weekly review")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    TerminalDoneButton { dismiss() }
                }
            }
            .task {
                let iso = ISO8601DateFormatter()
                let cutoff = Date().addingTimeInterval(-7 * 86_400)
                shipped = (await model.archive()).filter { loop in
                    guard loop.status == "closed", let ts = loop.resolvedTs, let d = iso.date(from: ts) else { return false }
                    return d >= cutoff
                }
                loading = false
            }
        }
    }

    private func actionRow(_ loop: OpenLoop) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            LoopRow(loop: loop)
            HStack(spacing: 16) {
                TerminalActionButton(title: "done", tint: .green) {
                    Task { await model.markDone(loop) }
                }
                TerminalActionButton(title: "tomorrow", tint: .orange) {
                    Task { await model.snooze(loop, days: 1) }
                }
            }
        }
    }
}
