import SwiftUI

/// Relationship-centric view: per person, what you owe them and what they owe you — for 1:1 prep.
struct PeopleView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    private struct Person: Identifiable {
        let name: String
        let owe: Int
        let owed: Int
        let overdue: Int
        var id: String { name }
    }

    private var people: [Person] {
        guard let brief = model.brief else { return [] }
        let oweLoops = brief.overdue + brief.today + brief.upcoming + brief.noDate
        var tally: [String: (owe: Int, owed: Int, overdue: Int)] = [:]
        func key(_ loop: OpenLoop) -> String? {
            let c = loop.counterpart.trimmingCharacters(in: .whitespaces)
            return (c.isEmpty || c.lowercased() == "unknown") ? nil : c
        }
        for loop in oweLoops { if let k = key(loop) { tally[k, default: (0, 0, 0)].owe += 1 } }
        for loop in brief.overdue { if let k = key(loop) { tally[k, default: (0, 0, 0)].overdue += 1 } }
        for loop in brief.awaiting { if let k = key(loop) { tally[k, default: (0, 0, 0)].owed += 1 } }
        return tally
            .map { Person(name: $0.key, owe: $0.value.owe, owed: $0.value.owed, overdue: $0.value.overdue) }
            .sorted { ($0.owe + $0.owed, $0.name) > ($1.owe + $1.owed, $1.name) }
    }

    var body: some View {
        NavigationStack {
            List {
                if people.isEmpty {
                    ContentUnavailableView("No people yet", systemImage: "person.2", description: Text("Loops with a named counterpart appear here."))
                        .listRowBackground(Color.clear)
                } else {
                    ForEach(people) { person in
                        VStack(alignment: .leading, spacing: 3) {
                            Text(person.name).font(.mono)
                            HStack(spacing: 10) {
                                if person.owe > 0 { Text("you owe \(person.owe)") }
                                if person.owed > 0 { Text("waiting on \(person.owed)").foregroundStyle(.teal) }
                                if person.overdue > 0 { Text("\(person.overdue) overdue").foregroundStyle(.red) }
                            }
                            .font(.monoSmall)
                            .foregroundStyle(.secondary)
                        }
                    }
                    .listRowBackground(Color.clear)
                }
            }
            .terminalListBackground()
            .navigationTitle("people")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    TerminalDoneButton { dismiss() }
                }
            }
        }
    }
}
