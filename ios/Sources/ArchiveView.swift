import SwiftUI

/// The accomplishments log: loops you've closed or dismissed, grouped by the day they resolved.
/// Read-only history — the raw material for standups, brag-docs, and analytics.
struct ArchiveView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var loops: [OpenLoop] = []
    @State private var loading = true

    var body: some View {
        NavigationStack {
            List {
                if loading {
                    HStack { Spacer(); ProgressView(); Spacer() }
                } else if loops.isEmpty {
                    ContentUnavailableView("Nothing closed yet", systemImage: "checkmark.circle", description: Text("Loops you complete or dismiss show up here."))
                } else {
                    ForEach(grouped, id: \.day) { group in
                        Section(group.day) { ForEach(group.loops) { row($0) } }
                    }
                }
            }
            .navigationTitle("Completed")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
            .task { loops = await model.archive(); loading = false }
        }
    }

    private func row(_ loop: OpenLoop) -> some View {
        HStack(spacing: 10) {
            Image(systemName: loop.status == "dismissed" ? "trash" : "checkmark.circle.fill")
                .foregroundStyle(loop.status == "dismissed" ? Color.secondary : .green)
            VStack(alignment: .leading, spacing: 2) {
                Text(loop.summary).lineLimit(2)
                if let sub = subtitle(loop) { Text(sub).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
            }
        }
    }

    private func subtitle(_ loop: OpenLoop) -> String? {
        var parts: [String] = []
        if !loop.counterpart.isEmpty, loop.counterpart.lowercased() != "unknown" { parts.append(loop.counterpart) }
        if let r = loop.resolution { parts.append(r) }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// Group by resolved calendar day, newest day first (loops arrive pre-sorted by resolvedTs desc).
    private var grouped: [(day: String, loops: [OpenLoop])] {
        let iso = ISO8601DateFormatter()
        let fmt = DateFormatter()
        fmt.dateStyle = .medium
        var order: [String] = []
        var byDay: [String: [OpenLoop]] = [:]
        for loop in loops {
            let day: String = {
                guard let ts = loop.resolvedTs, let d = iso.date(from: ts) else { return "Earlier" }
                return fmt.string(from: d)
            }()
            if byDay[day] == nil { order.append(day); byDay[day] = [] }
            byDay[day]?.append(loop)
        }
        return order.map { (day: $0, loops: byDay[$0] ?? []) }
    }
}
