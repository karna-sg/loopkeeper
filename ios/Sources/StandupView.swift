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
                    .font(.mono)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding()
            }
            .background(Theme.terminalBG.ignoresSafeArea())
            .navigationTitle("standup")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    TerminalDoneButton { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        UIPasteboard.general.string = text
                        Haptics.success()
                    } label: {
                        Text("[ copy ]")
                            .font(.mono)
                            .foregroundStyle(Theme.headerAccent)
                    }
                    .buttonStyle(.plain)
                    .disabled(!ready)
                }
            }
            .safeAreaInset(edge: .bottom) {
                Text("Copy-only — Loopkeeper never posts this for you.")
                    .font(.monoSmall).foregroundStyle(.tertiary).padding(.bottom, 8)
            }
        }
        .task { text = await model.standupText(); ready = true }
    }
}
