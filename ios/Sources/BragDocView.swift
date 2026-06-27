import SwiftUI

/// A self-building accomplishments doc: the last 90 days of closed loops grouped by who, ready to
/// copy or share into a performance-review / promo packet. Generated on demand, never sent.
struct BragDocView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var text = "Composing…"
    @State private var ready = false

    var body: some View {
        NavigationStack {
            ScrollView {
                Text(text)
                    .font(.callout)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding()
            }
            .navigationTitle("Brag doc")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button("Done") { dismiss() } }
                ToolbarItem(placement: .topBarTrailing) { if ready { ShareLink(item: text) } }
            }
            .safeAreaInset(edge: .bottom) {
                Text("Last 90 days of closed loops, grouped by who. Copy or share into your review doc.")
                    .font(.caption2).foregroundStyle(.secondary).padding(.bottom, 8)
            }
        }
        .task { text = await model.bragDocText(); ready = true }
    }
}
