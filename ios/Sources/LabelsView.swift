import SwiftUI

/// Manage LoopKeeper labels: create, rename, recolor, delete.
/// Reached via the actions menu (⋯ → Manage labels).
struct LabelsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    @State private var newName = ""
    @State private var newColor = Theme.labelPalette[0].hex
    @State private var editingLabel: EngLabel?
    @State private var editName = ""
    @State private var editColor = ""

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(model.labels) { lbl in
                        HStack(spacing: 10) {
                            Circle()
                                .fill(Theme.labelColor(lbl.color))
                                .frame(width: 12, height: 12)
                            Text(lbl.name)
                                .font(.mono)
                            Spacer()
                            Button {
                                editingLabel = lbl
                                editName = lbl.name
                                editColor = lbl.color
                            } label: {
                                Image(systemName: "pencil").foregroundStyle(.secondary)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .onDelete { offsets in
                        for i in offsets {
                            Task { await model.deleteLabel(id: model.labels[i].id) }
                        }
                    }
                } header: {
                    TerminalSectionHeader("# labels")
                }
                .listRowBackground(Color.clear)

                Section {
                    TextField("label name", text: $newName)
                        .font(.mono)
                    ColorPaletteRow(selected: $newColor)
                    TerminalActionButton(title: "create label") {
                        guard !newName.isEmpty else { return }
                        let name = newName; let color = newColor
                        newName = ""
                        Task { await model.createLabel(name: name, color: color) }
                    }
                    .disabled(newName.isEmpty)
                } header: {
                    TerminalSectionHeader("# new label")
                }
                .listRowBackground(Color.clear)
            }
            .terminalListBackground()
            .navigationTitle("labels")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    TerminalDoneButton { dismiss() }
                }
            }
            .sheet(item: $editingLabel) { lbl in
                EditLabelSheet(label: lbl, name: $editName, color: $editColor) {
                    Task { await model.updateLabel(id: lbl.id, name: editName, color: editColor) }
                }
            }
        }
    }
}

private struct EditLabelSheet: View {
    let label: EngLabel
    @Binding var name: String
    @Binding var color: String
    let onSave: () -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section("Name") {
                    TextField("Label name", text: $name)
                        .font(.mono)
                }
                Section("Color") {
                    ColorPaletteRow(selected: $color)
                }
            }
            .navigationTitle("edit label")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { dismiss() } label: {
                        Text("[ cancel ]").font(.mono).foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { onSave(); dismiss() } label: {
                        Text("[ save ]").font(.mono).foregroundStyle(Theme.headerAccent)
                    }
                    .buttonStyle(.plain)
                    .disabled(name.isEmpty)
                }
            }
        }
    }
}

/// A horizontal row of color swatches for the Trello-style label palette.
struct ColorPaletteRow: View {
    @Binding var selected: String

    var body: some View {
        HStack(spacing: 8) {
            ForEach(Theme.labelPalette, id: \.hex) { entry in
                Button {
                    selected = entry.hex
                } label: {
                    ZStack {
                        Circle().fill(Theme.labelColor(entry.hex)).frame(width: 28, height: 28)
                        if selected == entry.hex {
                            Image(systemName: "checkmark")
                                .font(.system(size: 11, weight: .bold))
                                .foregroundStyle(.white)
                        }
                    }
                }
                .buttonStyle(.plain)
                .accessibilityLabel(entry.name)
            }
        }
        .padding(.vertical, 4)
    }
}
