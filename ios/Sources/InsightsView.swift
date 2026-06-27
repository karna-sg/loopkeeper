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
                } else if let stats {
                    content(stats)
                } else {
                    ContentUnavailableView("No insights", systemImage: "chart.bar", description: Text("Couldn't load stats — check the connection."))
                }
            }
            .navigationTitle("Insights")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
            .task { stats = await model.stats(); loading = false }
        }
    }

    @ViewBuilder private func content(_ s: Stats) -> some View {
        Section("Reliability") {
            LabeledContent("On-time rate", value: s.onTimeRate.map { "\(Int(($0 * 100).rounded()))%" } ?? "—")
            LabeledContent("On-time streak", value: "\(s.onTimeStreak)")
            LabeledContent("Median time to close", value: s.medianTimeToCloseHours.map(humanHours) ?? "—")
            LabeledContent("Carry-over (owe > 7d)") { Text("\(s.carryOver)").foregroundStyle(s.carryOver > 0 ? .orange : .secondary) }
        }
        Section("Open now") {
            LabeledContent("You owe", value: "\(s.open.owe)")
            LabeledContent("Waiting on others", value: "\(s.open.owed)")
            LabeledContent("Overdue") { Text("\(s.open.overdue)").foregroundStyle(s.open.overdue > 0 ? .red : .secondary) }
        }
        Section("Shipped") {
            LabeledContent("Closed (all time)", value: "\(s.closed.total)")
            LabeledContent("Last 7 days", value: "\(s.closed.last7)")
            LabeledContent("Last 30 days", value: "\(s.closed.last30)")
            LabeledContent("Dismissed", value: "\(s.dismissed.total)")
        }
        if !s.byWeek.isEmpty {
            Section("Closed per week") {
                let peak = max(s.byWeek.map(\.closed).max() ?? 1, 1)
                ForEach(s.byWeek) { w in
                    HStack(spacing: 8) {
                        Text(w.week).font(.caption).foregroundStyle(.secondary).frame(width: 78, alignment: .leading)
                        GeometryReader { geo in
                            Capsule().fill(.tint)
                                .frame(width: max(6, geo.size.width * CGFloat(w.closed) / CGFloat(peak)))
                        }
                        .frame(height: 10)
                        Text("\(w.closed)").font(.caption).monospacedDigit()
                    }
                }
            }
        }
    }

    private func humanHours(_ h: Double) -> String {
        h < 24 ? "\(Int(h.rounded()))h" : "\(Int((h / 24).rounded()))d"
    }
}
