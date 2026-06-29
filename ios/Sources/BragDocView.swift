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
                    .font(.mono)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding()
            }
            .background(Theme.terminalBG.ignoresSafeArea())
            .navigationTitle("brag doc")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    TerminalDoneButton { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    if ready {
                        ShareLink(item: text) {
                            Text("[ share ]")
                                .font(.mono)
                                .foregroundStyle(Theme.headerAccent)
                        }
                    }
                }
            }
            .safeAreaInset(edge: .bottom) {
                Text("Last 90 days of closed loops, grouped by who. Copy or share into your review doc.")
                    .font(.monoSmall).foregroundStyle(.tertiary).padding(.bottom, 8)
            }
        }
        .task { text = await model.bragDocText(); ready = true }
    }
}
