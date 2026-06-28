import SwiftUI

/// Configure which sources Loopkeeper reads: Gmail importance + extra Slack channels.
/// (DMs and @mentions are always read.) Terminal-clean to match Home + Settings.
struct ChannelsView: View {
    @State private var channels: [SlackChannelDTO] = []
    @State private var selected: Set<String> = []
    @State private var slackScope = "selected"
    @State private var gmailQuery = "in:inbox category:primary newer_than:7d"
    @State private var slackError: String?
    @State private var loading = true
    @State private var saving = false

    private let api = APIClient()
    private let mono = Font.system(size: 13, design: .monospaced)
    private let monoSmall = Font.system(size: 11, design: .monospaced)

    private let gmailOptions: [(String, String)] = [
        ("primary only", "in:inbox category:primary newer_than:7d"),
        ("important", "in:inbox is:important newer_than:7d"),
        ("all inbox", "in:inbox newer_than:7d"),
    ]
    private let slackOptions: [(String, String)] = [
        ("all my channels", "all_member"),
        ("selected only", "selected"),
    ]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                section("# gmail — which mail to scan") {
                    ForEach(gmailOptions, id: \.1) { opt in
                        option(opt.0, selected: gmailQuery == opt.1) { gmailQuery = opt.1 }
                    }
                    help("Primary keeps out newsletters, promotions and notifications — fewer false reminders.")
                }

                section("# slack — what to watch") {
                    ForEach(slackOptions, id: \.1) { opt in
                        option(opt.0, selected: slackScope == opt.1) { slackScope = opt.1 }
                    }
                    help("DMs and @mentions are always read. \"Selected only\" (recommended) reads just the channels you pick — less noise. \"All my channels\" reads every channel you're in.")
                    if let slackError {
                        (Text("! ").foregroundColor(.orange) + Text(slackError).foregroundColor(.secondary)).font(monoSmall)
                    }
                }

                if slackScope == "selected" {
                    section("# channels to watch") {
                        if channels.isEmpty {
                            Text(loading ? "loading…" : "no channels found").font(monoSmall).foregroundStyle(.tertiary)
                        }
                        ForEach(channels) { ch in
                            channelToggle(ch)
                        }
                    }
                }

                button(saving ? "saving…" : "save", tint: saving ? .secondary : Theme.headerAccent) {
                    Task { await save() }
                }
                .disabled(saving)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(Theme.terminalBG.ignoresSafeArea())
        .navigationTitle("channels")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    // MARK: terminal building blocks

    @ViewBuilder private func section<Content: View>(_ title: String, @ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title).font(.system(size: 12, weight: .semibold, design: .monospaced)).foregroundStyle(Theme.headerAccent)
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func help(_ s: String) -> some View {
        Text(s).font(monoSmall).foregroundStyle(.tertiary).fixedSize(horizontal: false, vertical: true)
    }

    private func option(_ label: String, selected isOn: Bool, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Text(isOn ? "(•)" : "( )").font(mono).foregroundStyle(isOn ? Theme.headerAccent : .secondary)
                Text(label).font(mono).foregroundStyle(.primary)
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func channelToggle(_ ch: SlackChannelDTO) -> some View {
        let on = selected.contains(ch.id)
        return Button {
            if on { selected.remove(ch.id) } else { selected.insert(ch.id) }
        } label: {
            HStack {
                Text("#\(ch.name)").font(mono).foregroundStyle(.primary)
                Spacer()
                Text(on ? "[on]" : "[off]").font(mono).foregroundStyle(on ? .green : .secondary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func button(_ title: String, tint: Color = Theme.headerAccent, action: @escaping () -> Void) -> some View {
        Button(action: action) { Text("[ \(title) ]").font(mono).foregroundStyle(tint) }.buttonStyle(.plain)
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
