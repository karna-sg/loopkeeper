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
                } else if let stats {
                    content(stats)
                } else {
                    ContentUnavailableView("No insights", systemImage: "cpu", description: Text("Couldn't load eng stats — check the connection."))
                }
            }
            .navigationTitle("Eng Insights")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
            .task { stats = await model.engStats(); loading = false }
        }
    }

    @ViewBuilder private func content(_ s: EngStats) -> some View {
        Section("Throughput") {
            LabeledContent("Shipped (all time)", value: "\(s.shipped.total)")
            LabeledContent("Last 7 days", value: "\(s.shipped.last7)")
            LabeledContent("Last 30 days", value: "\(s.shipped.last30)")
            LabeledContent("In-flight", value: "\(s.inFlight.total)")
        }
        Section("Velocity") {
            LabeledContent("Median time to PR", value: s.medianTimeToPrHours.map(humanHours) ?? "—")
            LabeledContent("Median time to merge", value: s.medianTimeToMergeHours.map(humanHours) ?? "—")
        }
        Section("Review") {
            LabeledContent("Median review rounds",
                value: s.medianReviewRounds.map { String(format: "%.1f", $0) } ?? "—")
        }
        // Subscription detection: last30 spend is $0 despite shipped work → running on subscription OAuth.
        let onSubscription = s.spend.last30UsdCents == 0 && s.shipped.total > 0
        Section("Spend") {
            if onSubscription {
                LabeledContent("Last 7 days", value: "n/a on subscription")
                LabeledContent("Last 30 days", value: "n/a on subscription")
                LabeledContent("Total iterations", value: "\(s.spend.totalIterations)")
            } else {
                LabeledContent("Last 7 days", value: formatCents(s.spend.last7UsdCents))
                LabeledContent("Last 30 days", value: formatCents(s.spend.last30UsdCents))
            }
        }
        if !s.byWeek.isEmpty {
            Section("Shipped per week") {
                let peak = max(s.byWeek.map(\.shipped).max() ?? 1, 1)
                ForEach(s.byWeek) { w in
                    HStack(spacing: 8) {
                        Text(w.week).font(.caption).foregroundStyle(.secondary).frame(width: 78, alignment: .leading)
                        GeometryReader { geo in
                            Capsule().fill(.tint)
                                .frame(width: max(6, geo.size.width * CGFloat(w.shipped) / CGFloat(peak)))
                        }
                        .frame(height: 10)
                        Text("\(w.shipped)").font(.caption).monospacedDigit()
                    }
                }
            }
        }
    }

    private func formatCents(_ cents: Int) -> String {
        String(format: "$%.2f", Double(cents) / 100.0)
    }

    private func humanHours(_ h: Double) -> String {
        h < 24 ? "\(Int(h.rounded()))h" : "\(Int((h / 24).rounded()))d"
    }
}
