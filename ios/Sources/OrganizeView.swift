import SwiftUI

/// Set a loop's project and tags — for grouping and search. Kept tiny on purpose.
struct OrganizeView: View {
    let loop: OpenLoop
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var project: String
    @State private var tagsText: String

    init(loop: OpenLoop) {
        self.loop = loop
        _project = State(initialValue: loop.project ?? "")
        _tagsText = State(initialValue: (loop.tags ?? []).joined(separator: ", "))
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Project") { TextField("e.g. Q3 launch", text: $project) }
                Section("Tags") {
                    TextField("comma, separated", text: $tagsText)
                    Text("Used for search and grouping (e.g. deep, waiting, vendor).").font(.caption).foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Organize")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Save") {
                        let tags = tagsText.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
                        let proj = project.trimmingCharacters(in: .whitespaces)
                        Task { await model.organize(loop, project: proj.isEmpty ? nil : proj, tags: tags); dismiss() }
                    }
                }
            }
        }
    }
}
