import SwiftUI

/// The accountability mirror: reliability, throughput, and an at-a-glance ROI ledger, all derived
/// from the loop lifecycle the app already records.
struct InsightsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var stats: Stats?
    @State private var loading = true

    var body: some View {
        NavigationStack {
            List {
                if loading {
                    HStack { Spacer(); ProgressView(); Spacer() }
                        .listRowBackground(Color.clear)
                } else if let stats {
                    content(stats)
                } else {
                    ContentUnavailableView("No insights", systemImage: "chart.bar", description: Text("Couldn't load stats — check the connection."))
                        .listRowBackground(Color.clear)
                }
            }
            .terminalListBackground()
            .navigationTitle("insights")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    TerminalDoneButton { dismiss() }
                }
            }
            .task { stats = await model.stats(); loading = false }
        }
    }

    @ViewBuilder private func content(_ s: Stats) -> some View {
        Section {
            TerminalStatRow(label: "on-time rate", value: s.onTimeRate.map { "\(Int(($0 * 100).rounded()))%" } ?? "—")
            TerminalStatRow(label: "on-time streak", value: "\(s.onTimeStreak)")
            TerminalStatRow(label: "median time to close", value: s.medianTimeToCloseHours.map(humanHours) ?? "—")
            TerminalStatRow(label: "carry-over (owe > 7d)", value: "\(s.carryOver)",
                            valueTint: s.carryOver > 0 ? .orange : .primary)
        } header: {
            TerminalSectionHeader("# reliability")
        }
        .listRowBackground(Color.clear)

        Section {
            TerminalStatRow(label: "you owe", value: "\(s.open.owe)")
            TerminalStatRow(label: "waiting on others", value: "\(s.open.owed)")
            TerminalStatRow(label: "overdue", value: "\(s.open.overdue)",
                            valueTint: s.open.overdue > 0 ? .red : .primary)
        } header: {
            TerminalSectionHeader("# open_now")
        }
        .listRowBackground(Color.clear)

        Section {
            TerminalStatRow(label: "closed (all time)", value: "\(s.closed.total)")
            TerminalStatRow(label: "last 7 days", value: "\(s.closed.last7)")
            TerminalStatRow(label: "last 30 days", value: "\(s.closed.last30)")
            TerminalStatRow(label: "dismissed", value: "\(s.dismissed.total)")
        } header: {
            TerminalSectionHeader("# shipped")
        }
        .listRowBackground(Color.clear)

        if !s.byWeek.isEmpty {
            Section {
                let peak = max(s.byWeek.map(\.closed).max() ?? 1, 1)
                ForEach(s.byWeek) { w in
                    TerminalBarRow(label: w.week, value: w.closed, peak: peak)
                }
            } header: {
                TerminalSectionHeader("# closed_per_week")
            }
            .listRowBackground(Color.clear)
        }
    }

    private func humanHours(_ h: Double) -> String {
        h < 24 ? "\(Int(h.rounded()))h" : "\(Int((h / 24).rounded()))d"
    }
}
