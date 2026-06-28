import SwiftUI

/// Settings, terminal-clean to match Home: monospaced `# section` headers, plain `[ action ]`
/// buttons/links, terminal toggles, and bordered mono fields — no grouped Form cards. Pushed inside
/// the app's NavigationStack (the NavigationLink to Channels still works).
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

    private let mono = Font.system(size: 13, design: .monospaced)
    private let monoSmall = Font.system(size: 11, design: .monospaced)

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                backend
                accounts
                engineering
                sources
                extraction
                notifications
                data
                maintenance
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(Theme.terminalBG.ignoresSafeArea())
        .navigationTitle("settings")
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog("Clear all reminders and re-scan?", isPresented: $showResetConfirm, titleVisibility: .visible) {
            Button("Clear & re-scan", role: .destructive) { Task { await model.resetAndRescan() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Your done/snoozed state is reset too. The scan rebuilds the current reminders.")
        }
    }

    // MARK: sections

    private var backend: some View {
        section("# backend") {
            field("backend url", text: $backendURL, keyboard: .URL)
            field("api token (optional)", text: $apiToken, secure: true)
            help("On the iPhone, use your Mac's LAN IP or a tunnel — and the API token if the backend requires one.")
            button("apply & refresh") {
                model.reloadClient()
                Task { await model.refresh() }
                dismiss()
            }
        }
    }

    private var accounts: some View {
        section("# accounts") {
            if let connected = model.health?.connected, !connected.isEmpty {
                ForEach(connected, id: \.self) { conn in
                    HStack(spacing: 8) {
                        Image(systemName: Theme.channelIcon(conn.provider))
                            .font(.system(size: 11))
                            .foregroundStyle(Theme.channelTint(conn.provider, scheme: scheme))
                            .frame(width: 14)
                        Text(conn.provider.lowercased()).font(mono).foregroundStyle(.secondary)
                        Text(conn.account).font(mono).foregroundStyle(.primary).textSelection(.enabled)
                        Spacer(minLength: 0)
                    }
                }
            } else {
                Text("none connected yet").font(monoSmall).foregroundStyle(.tertiary)
            }
            link("connect slack", connectURL("slack"))
            link("connect gmail", connectURL("google"))
        }
    }

    private var engineering: some View {
        section("# engineering") {
            link("connect jira", connectURL("jira"))
            help("Connects read-only and imports the Jira issues assigned to you. The repo, GitHub token, and Claude Code run on the cloud worker — never in the app.")
        }
    }

    private var sources: some View {
        section("# sources") {
            NavigationLink { ChannelsView() } label: {
                HStack(spacing: 6) {
                    Text("[ channels & importance ]").font(mono).foregroundStyle(Theme.headerAccent)
                    Image(systemName: "chevron.right").font(.system(size: 9, weight: .semibold)).foregroundStyle(.tertiary)
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            help("Pick Slack channels and how much Gmail to scan.")
        }
    }

    private var extraction: some View {
        section("# extraction") {
            HStack(spacing: 6) {
                Text(model.extractionConfigured ? "✓" : "!")
                    .font(mono).foregroundStyle(model.extractionConfigured ? .green : .orange)
                Text(model.extractionConfigured ? "ai model configured" : "set ANTHROPIC_API_KEY on the backend")
                    .font(mono).foregroundStyle(.secondary)
            }
        }
    }

    private var notifications: some View {
        section("# notifications") {
            button("enable reminders") {
                Task {
                    await LocalNudges.requestAuthorization()
                    if let brief = model.brief { LocalNudges.reschedule(brief) }
                }
            }
            toggle("follow-up reminders", $nudgeWaiting) { reschedule() }
            toggle("morning review (9am)", $morningReview) { reschedule() }
            help("On-device reminders at 9am before a loop is due. Follow-up reminders nudge you on overdue things others owe you; morning review is a daily summary.")
        }
    }

    private var data: some View {
        section("# data") {
            button("export all loops (json)") {
                Task {
                    exporting = true
                    if let json = await model.exportJSON() {
                        let url = FileManager.default.temporaryDirectory.appendingPathComponent("loopkeeper-export.json")
                        try? Data(json.utf8).write(to: url)
                        exportURL = url
                    }
                    exporting = false
                }
            }
            if exporting { Text("preparing…").font(monoSmall).foregroundStyle(.tertiary) }
            if let exportURL {
                ShareLink(item: exportURL) { Text("[ share backup ]").font(mono).foregroundStyle(Theme.headerAccent) }
            }
            help("A full JSON backup of every loop. Prepare it, then Share to Files, mail, etc.")
        }
    }

    private var maintenance: some View {
        section("# maintenance") {
            button("clear all & re-scan", tint: .red) { showResetConfirm = true }
            help("Wipes current reminders and rebuilds them from a fresh scan. Useful to clear old duplicates.")
        }
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

    private func button(_ title: String, tint: Color = Theme.headerAccent, action: @escaping () -> Void) -> some View {
        Button(action: action) { Text("[ \(title) ]").font(mono).foregroundStyle(tint) }.buttonStyle(.plain)
    }

    private func link(_ title: String, _ url: URL) -> some View {
        Link(destination: url) { Text("[ \(title) ]").font(mono).foregroundStyle(Theme.headerAccent) }
    }

    private func toggle(_ title: String, _ isOn: Binding<Bool>, onChange: @escaping () -> Void = {}) -> some View {
        Button {
            isOn.wrappedValue.toggle()
            onChange()
        } label: {
            HStack {
                Text(title).font(mono).foregroundStyle(.primary)
                Spacer()
                Text(isOn.wrappedValue ? "[on]" : "[off]")
                    .font(mono).foregroundStyle(isOn.wrappedValue ? .green : .secondary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder private func field(_ placeholder: String, text: Binding<String>, secure: Bool = false, keyboard: UIKeyboardType = .default) -> some View {
        Group {
            if secure {
                SecureField(placeholder, text: text)
            } else {
                TextField(placeholder, text: text).keyboardType(keyboard)
            }
        }
        .font(mono)
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .padding(8)
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.secondary.opacity(0.3), lineWidth: 1))
    }

    private func reschedule() {
        if let brief = model.brief { LocalNudges.reschedule(brief) }
    }

    private func connectURL(_ provider: String) -> URL {
        URL(string: backendURL + "/auth/" + provider) ?? AppConfig.baseURL
    }
}
