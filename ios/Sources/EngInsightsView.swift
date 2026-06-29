import SwiftUI

/// Engineering throughput, velocity, and cost metrics — the counterpart to InsightsView for loops.
struct EngInsightsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var stats: EngStats?
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
                    ContentUnavailableView("No insights", systemImage: "cpu", description: Text("Couldn't load eng stats — check the connection."))
                        .listRowBackground(Color.clear)
                }
            }
            .terminalListBackground()
            .navigationTitle("eng insights")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    TerminalDoneButton { dismiss() }
                }
            }
            .task { stats = await model.engStats(); loading = false }
        }
    }

    @ViewBuilder private func content(_ s: EngStats) -> some View {
        Section {
            TerminalStatRow(label: "shipped (all time)", value: "\(s.shipped.total)")
            TerminalStatRow(label: "last 7 days", value: "\(s.shipped.last7)")
            TerminalStatRow(label: "last 30 days", value: "\(s.shipped.last30)")
            TerminalStatRow(label: "in-flight", value: "\(s.inFlight.total)")
        } header: {
            TerminalSectionHeader("# throughput")
        }
        .listRowBackground(Color.clear)

        Section {
            TerminalStatRow(label: "median time to pr", value: s.medianTimeToPrHours.map(humanHours) ?? "—")
            TerminalStatRow(label: "median time to merge", value: s.medianTimeToMergeHours.map(humanHours) ?? "—")
        } header: {
            TerminalSectionHeader("# velocity")
        }
        .listRowBackground(Color.clear)

        Section {
            TerminalStatRow(label: "median review rounds",
                            value: s.medianReviewRounds.map { String(format: "%.1f", $0) } ?? "—")
        } header: {
            TerminalSectionHeader("# review")
        }
        .listRowBackground(Color.clear)

        // Subscription detection: last30 spend is $0 despite shipped work → running on subscription OAuth.
        let onSubscription = s.spend.last30UsdCents == 0 && s.shipped.total > 0
        Section {
            if onSubscription {
                TerminalStatRow(label: "last 7 days", value: "n/a on subscription")
                TerminalStatRow(label: "last 30 days", value: "n/a on subscription")
                TerminalStatRow(label: "total iterations", value: "\(s.spend.totalIterations)")
            } else {
                TerminalStatRow(label: "last 7 days", value: formatCents(s.spend.last7UsdCents))
                TerminalStatRow(label: "last 30 days", value: formatCents(s.spend.last30UsdCents))
            }
        } header: {
            TerminalSectionHeader("# spend")
        }
        .listRowBackground(Color.clear)

        if !s.byWeek.isEmpty {
            Section {
                let peak = max(s.byWeek.map(\.shipped).max() ?? 1, 1)
                ForEach(s.byWeek) { w in
                    TerminalBarRow(label: w.week, value: w.shipped, peak: peak)
                }
            } header: {
                TerminalSectionHeader("# shipped_per_week")
            }
            .listRowBackground(Color.clear)
        }
    }

    private func formatCents(_ cents: Int) -> String {
        String(format: "$%.2f", Double(cents) / 100.0)
    }

    private func humanHours(_ h: Double) -> String {
        h < 24 ? "\(Int(h.rounded()))h" : "\(Int((h / 24).rounded()))d"
    }
}
