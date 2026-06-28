import SwiftUI

/// In-app diff viewer — lazy-loaded, collapsible per file, +/- colored lines.
/// Falls back to an "open on GitHub" link when the diff is unavailable or empty.
struct DiffView: View {
    let taskId: String
    let fallbackURL: URL?

    @Environment(\.openURL) private var openURL
    @State private var files: [DiffFile] = []
    @State private var truncated = false
    @State private var loading = false
    @State private var errorMsg: String? = nil
    @State private var expandedFiles: Set<String> = []

    private let mono = Font.system(size: 12, design: .monospaced)
    private let monoSmall = Font.system(size: 11, design: .monospaced)

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if loading {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.mini)
                    Text("loading diff…").font(monoSmall).foregroundStyle(.secondary)
                }
            } else if let err = errorMsg {
                Text(err).font(monoSmall).foregroundStyle(.secondary)
                fallbackLink
            } else if files.isEmpty {
                Text("no diff available").font(monoSmall).foregroundStyle(.tertiary)
                fallbackLink
            } else {
                ForEach(files) { file in
                    fileSection(file)
                }
                if truncated {
                    Text("⋯ diff truncated — open on GitHub for the full diff")
                        .font(monoSmall).foregroundStyle(.tertiary)
                    fallbackLink
                }
            }
        }
        .task(id: taskId) { await loadDiff() }
    }

    @ViewBuilder private var fallbackLink: some View {
        if let url = fallbackURL {
            Button { openURL(url) } label: {
                HStack(spacing: 4) {
                    Text("[ open on GitHub ]").font(mono)
                    Image(systemName: "arrow.up.right").font(.system(size: 10))
                }
                .foregroundStyle(.blue)
            }
            .buttonStyle(.plain)
        }
    }

    @ViewBuilder private func fileSection(_ file: DiffFile) -> some View {
        let expanded = expandedFiles.contains(file.id)
        VStack(alignment: .leading, spacing: 0) {
            // File header row — always visible
            Button {
                if expanded { expandedFiles.remove(file.id) }
                else { expandedFiles.insert(file.id) }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: expanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 9, weight: .medium))
                        .foregroundStyle(.secondary)
                    fileStats(file)
                    Text(file.path)
                        .font(monoSmall)
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer()
                }
            }
            .buttonStyle(.plain)
            .padding(.vertical, 3)

            // Hunks — only when expanded
            if expanded {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(file.hunks.enumerated()), id: \.offset) { _, hunk in
                        hunkView(hunk)
                    }
                }
                .padding(.leading, 12)
            }
        }
    }

    @ViewBuilder private func fileStats(_ file: DiffFile) -> some View {
        let add = file.additions ?? 0
        let del = file.deletions ?? 0
        HStack(spacing: 3) {
            if add > 0 {
                Text("+\(add)").font(monoSmall).foregroundStyle(.green)
            }
            if del > 0 {
                Text("-\(del)").font(monoSmall).foregroundStyle(.red)
            }
        }
    }

    @ViewBuilder private func hunkView(_ hunk: DiffHunk) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(hunk.header)
                .font(monoSmall)
                .foregroundStyle(.tertiary)
                .padding(.top, 4)
            ForEach(Array(hunk.lines.enumerated()), id: \.offset) { _, line in
                diffLine(line)
            }
        }
    }

    @ViewBuilder private func diffLine(_ line: DiffLine) -> some View {
        let (prefix, color): (String, Color) = switch line.type {
        case "+": ("+", .green)
        case "-": ("-", .red)
        default:  (" ", .secondary)
        }
        (Text(prefix).foregroundColor(color) + Text(line.text).foregroundColor(color))
            .font(mono)
            .textSelection(.enabled)
    }

    private func loadDiff() async {
        loading = true
        errorMsg = nil
        do {
            let client = APIClient()
            let response = try await client.taskDiff(taskId)
            files = response.files
            truncated = response.truncated
            // Auto-expand the first file so there's immediate content
            if let first = response.files.first {
                expandedFiles.insert(first.id)
            }
        } catch {
            errorMsg = error.localizedDescription
        }
        loading = false
    }
}
