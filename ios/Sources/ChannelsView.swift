import SwiftUI

/// Configure which sources Loopkeeper reads: Gmail importance + extra Slack channels.
/// (DMs and @mentions are always read.)
struct ChannelsView: View {
    @State private var channels: [SlackChannelDTO] = []
    @State private var selected: Set<String> = []
    @State private var slackScope = "all_member"
    @State private var gmailQuery = "in:inbox category:primary newer_than:7d"
    @State private var slackError: String?
    @State private var loading = true
    @State private var saving = false

    private let api = APIClient()

    var body: some View {
        Form {
            Section("Gmail — which mail to scan") {
                Picker("Importance", selection: $gmailQuery) {
                    Text("Primary only").tag("in:inbox category:primary newer_than:7d")
                    Text("Important").tag("in:inbox is:important newer_than:7d")
                    Text("All inbox").tag("in:inbox newer_than:7d")
                }
                Text("Primary keeps out newsletters, promotions and notifications — fewer false reminders.")
                    .font(.caption).foregroundStyle(.secondary)
            }

            Section("Slack") {
                Picker("Watch", selection: $slackScope) {
                    Text("All my channels").tag("all_member")
                    Text("Selected only").tag("selected")
                }
                Text("DMs and @mentions are always read. \"All my channels\" also captures @channel / @here asks everywhere you're a member.")
                    .font(.caption).foregroundStyle(.secondary)
                if let slackError {
                    Label(slackError, systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(.orange)
                }
            }

            if slackScope == "selected" {
                Section("Channels to watch") {
                    ForEach(channels) { ch in
                        Toggle(ch.name, isOn: Binding(
                            get: { selected.contains(ch.id) },
                            set: { on in if on { selected.insert(ch.id) } else { selected.remove(ch.id) } }
                        ))
                    }
                }
            }

            Section {
                Button {
                    Task { await save() }
                } label: {
                    HStack { Text(saving ? "Saving…" : "Save"); if saving { Spacer(); ProgressView() } }
                }
                .disabled(saving)
            }
        }
        .navigationTitle("Channels")
        .overlay { if loading { ProgressView() } }
        .task { await load() }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            let response = try await api.channels()
            channels = response.slack
            slackError = response.slackError
            slackScope = response.slackScope
            gmailQuery = response.gmailQuery
            selected = Set(response.slack.filter(\.enabled).map(\.id))
        } catch {
            slackError = error.localizedDescription
        }
    }

    private func save() async {
        saving = true
        defer { saving = false }
        do {
            try await api.saveConfig(ConfigUpdate(slackScope: slackScope, slackChannelIds: Array(selected), gmailQuery: gmailQuery))
        } catch {
            slackError = error.localizedDescription
        }
    }
}
