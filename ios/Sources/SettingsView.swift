import SwiftUI

struct SettingsView: View {
    @AppStorage(AppConfig.backendURLKey) private var backendURL = "http://127.0.0.1:8787"
    @AppStorage(AppConfig.apiTokenKey) private var apiToken = ""
    @AppStorage(LocalNudges.nudgeWaitingKey) private var nudgeWaiting = true
    @AppStorage(LocalNudges.morningReviewKey) private var morningReview = true
    @Environment(AppModel.self) private var model
    @Environment(\.colorScheme) private var scheme
    @Environment(\.dismiss) private var dismiss
    @State private var showResetConfirm = false
    @State private var exportURL: URL?
    @State private var exporting = false

    var body: some View {
        Form {
            Section("Backend") {
                TextField("Backend URL", text: $backendURL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                SecureField("API token (optional)", text: $apiToken)
                Text("On the iPhone, use your Mac's LAN IP or a tunnel — and the API token if the backend requires one.")
                    .font(.caption).foregroundStyle(.secondary)
                Button("Apply & refresh") {
                    model.reloadClient()
                    Task { await model.refresh() }
                    dismiss()
                }
            }

            Section("Connected accounts") {
                if let connected = model.health?.connected, !connected.isEmpty {
                    ForEach(connected, id: \.self) { conn in
                        Label {
                            Text(conn.account).font(.body)
                            + Text("  ·  \(conn.provider.capitalized)").foregroundColor(.secondary)
                        } icon: {
                            Image(systemName: Theme.channelIcon(conn.provider)).foregroundStyle(Theme.channelTint(conn.provider, scheme: scheme))
                        }
                    }
                } else {
                    Text("None connected yet.").foregroundStyle(.secondary)
                }
                Link(destination: connectURL("slack")) { Label("Connect Slack", systemImage: "number.square.fill") }
                Link(destination: connectURL("google")) { Label("Connect Gmail", systemImage: "envelope.fill") }
            }

            Section("Engineering (Jira tasks)") {
                Link(destination: connectURL("jira")) { Label("Connect Jira", systemImage: "ticket.fill") }
                Text("Connects read-only and imports the Jira issues assigned to you. The repo, GitHub token, and Claude Code run on the cloud worker — never in the app.")
                    .font(.caption).foregroundStyle(.secondary)
            }

            Section("Sources") {
                NavigationLink { ChannelsView() } label: {
                    Label("Channels & importance", systemImage: "slider.horizontal.3")
                }
                Text("Pick Slack channels and how much Gmail to scan.")
                    .font(.caption).foregroundStyle(.secondary)
            }

            Section("Extraction") {
                Label(
                    model.extractionConfigured ? "AI model configured" : "Set ANTHROPIC_API_KEY on the backend",
                    systemImage: model.extractionConfigured ? "checkmark.seal.fill" : "exclamationmark.triangle.fill"
                )
                .foregroundStyle(model.extractionConfigured ? .green : .orange)
            }

            Section("Notifications") {
                Button("Enable reminders") {
                    Task {
                        await LocalNudges.requestAuthorization()
                        if let brief = model.brief { LocalNudges.reschedule(brief) }
                    }
                }
                Toggle("Follow-up reminders", isOn: $nudgeWaiting)
                Toggle("Morning review (9am)", isOn: $morningReview)
                Text("On-device reminders at 9am before a loop is due. Follow-up reminders nudge you on things others owe you that are overdue; morning review is a daily summary.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            .onChange(of: nudgeWaiting) { if let brief = model.brief { LocalNudges.reschedule(brief) } }
            .onChange(of: morningReview) { if let brief = model.brief { LocalNudges.reschedule(brief) } }

            Section("Data") {
                if let exportURL {
                    ShareLink(item: exportURL) { Label("Share backup", systemImage: "square.and.arrow.up") }
                }
                Button {
                    Task {
                        exporting = true
                        if let json = await model.exportJSON() {
                            let url = FileManager.default.temporaryDirectory.appendingPathComponent("loopkeeper-export.json")
                            try? Data(json.utf8).write(to: url)
                            exportURL = url
                        }
                        exporting = false
                    }
                } label: {
                    HStack {
                        Label("Export all loops (JSON)", systemImage: "arrow.down.doc")
                        if exporting { Spacer(); ProgressView() }
                    }
                }
                .disabled(exporting)
                Text("A full JSON backup of every loop. Prepare it, then Share to Files, mail, etc.")
                    .font(.caption).foregroundStyle(.secondary)
            }

            Section("Maintenance") {
                Button(role: .destructive) { showResetConfirm = true } label: {
                    Label("Clear all & re-scan", systemImage: "arrow.counterclockwise")
                }
                Text("Wipes current reminders and rebuilds them from a fresh scan. Useful to clear old duplicates.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Settings")
        .confirmationDialog("Clear all reminders and re-scan?", isPresented: $showResetConfirm, titleVisibility: .visible) {
            Button("Clear & re-scan", role: .destructive) { Task { await model.resetAndRescan() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Your done/snoozed state is reset too. The scan rebuilds the current reminders.")
        }
    }

    private func connectURL(_ provider: String) -> URL {
        URL(string: backendURL + "/auth/" + provider) ?? AppConfig.baseURL
    }
}
