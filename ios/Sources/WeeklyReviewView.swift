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
                        .font(.callout).foregroundStyle(.secondary)
                }
                Section("Shipped this week (\(shipped.count))") {
                    if loading {
                        ProgressView()
                    } else if shipped.isEmpty {
                        Text("Nothing closed in the last 7 days.").foregroundStyle(.secondary)
                    } else {
                        ForEach(shipped) { loop in
                            Label(loop.summary, systemImage: "checkmark.circle.fill").labelStyle(.titleAndIcon)
                        }
                    }
                }
                if !overdue.isEmpty {
                    Section("Still overdue (\(overdue.count))") {
                        ForEach(overdue) { loop in actionRow(loop) }
                    }
                }
                if !stale.isEmpty {
                    Section("Waiting too long (\(stale.count))") {
                        ForEach(stale) { loop in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(loop.summary).lineLimit(2)
                                if !loop.counterpart.isEmpty { Text("Waiting on \(loop.counterpart)").font(.caption).foregroundStyle(.secondary) }
                            }
                        }
                    }
                }
            }
            .navigationTitle("Weekly review")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
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
            HStack(spacing: 8) {
                Button { Task { await model.markDone(loop) } } label: { Label("Done", systemImage: "checkmark") }.tint(.green)
                Button { Task { await model.snooze(loop, days: 1) } } label: { Label("Tomorrow", systemImage: "clock") }.tint(.orange)
            }
            .buttonStyle(.bordered).controlSize(.small)
        }
    }
}
