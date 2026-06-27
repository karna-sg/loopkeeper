import SwiftUI

/// First-run / no-connections state: explain the value and route to connecting accounts.
struct OnboardingView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        ContentUnavailableView {
            Label("Connect your channels", systemImage: "link.circle.fill")
        } description: {
            Text("Loopkeeper watches Slack & Gmail for the things you promised, were asked, or owe — and keeps them in one list with the real due date, so nothing slips.")
        } actions: {
            NavigationLink { SettingsView() } label: {
                Text("Connect accounts").frame(maxWidth: 220)
            }
            .buttonStyle(.borderedProminent)
            Button("Refresh") { Task { await model.refresh() } }
        }
    }
}
