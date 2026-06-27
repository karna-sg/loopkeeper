import SwiftUI
import UIKit

/// A one-tap standup: what closed since yesterday, what's due today, what you're blocked on —
/// composed from the brief + archive. Copy-only; Loopkeeper never posts it (Tier-1 output).
struct StandupView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var text = "Composing…"
    @State private var ready = false

    var body: some View {
        NavigationStack {
            ScrollView {
                Text(text)
                    .font(.callout.monospaced())
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding()
            }
            .navigationTitle("Standup")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button("Done") { dismiss() } }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { UIPasteboard.general.string = text; Haptics.success() } label: { Label("Copy", systemImage: "doc.on.doc") }
                        .disabled(!ready)
                }
            }
            .safeAreaInset(edge: .bottom) {
                Text("Copy-only — Loopkeeper never posts this for you.")
                    .font(.caption2).foregroundStyle(.secondary).padding(.bottom, 8)
            }
        }
        .task { text = await model.standupText(); ready = true }
    }
}
