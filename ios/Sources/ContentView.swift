import SwiftUI

struct ContentView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openURL) private var openURL
    @AppStorage("loopkeeper.sortByPriority") private var sortByPriority = false
    /// Comma-separated keys of sections the user has collapsed (persisted).
    @AppStorage("loopkeeper.collapsedSections") private var collapsedCSV = ""
    @AppStorage("loopkeeper.filterStage")  private var filterStage   = "all"
    @AppStorage("loopkeeper.filterStatus") private var filterStatus  = "any"
    @AppStorage("loopkeeper.filterTags")   private var filterTagsCSV = ""
    @State private var selected: OpenLoop?
    @State private var selectedTask: EngTask?
    @State private var searchText = ""
    @State private var searchResults: [OpenLoop] = []
    @State private var showStandup = false
    @State private var showShutdown = false
    @State private var showArchive = false
    @State private var showInsights = false
    @State private var showPeople = false
    @State private var showWeekly = false
    @State private var showBragDoc = false
    @State private var showEngInsights = false
    @State private var showLabels = false
    @State private var labelPickerTask: EngTask?
    @AppStorage("loopkeeper.queueLabelId") private var queueLabelId = ""
    @State private var noDateExpanded = false

    var body: some View {
        @Bindable var model = model
        NavigationStack {
            VStack(spacing: 0) {
                warningBanner
                content
                    .refreshable { await model.refresh() }
                    .task {
                        await model.refresh()
                        model.autoSyncTasksIfNeeded()
                        if !queueLabelId.isEmpty { await model.loadLabelOrder(queueLabelId) }
                    }
                    .searchable(text: $searchText, placement: .navigationBarDrawer(displayMode: .automatic), prompt: "Search loops")
                    .onChange(of: searchText) { _, q in
                        Task { searchResults = q.trimmingCharacters(in: .whitespaces).isEmpty ? [] : await model.search(q) }
                    }
                    .sheet(item: $selected) { LoopDetailView(loop: $0) }
                    .sheet(item: $selectedTask) { TaskWorkspaceView(taskID: $0.id) }
                    .sheet(isPresented: $showStandup) { StandupView() }
                    .sheet(isPresented: $showShutdown) { ShutdownView() }
                    .sheet(isPresented: $showArchive) { ArchiveView() }
                    .sheet(isPresented: $showInsights) { InsightsView() }
                    .sheet(isPresented: $showPeople) { PeopleView() }
                    .sheet(isPresented: $showWeekly) { WeeklyReviewView() }
                    .sheet(isPresented: $showBragDoc) { BragDocView() }
                    .sheet(isPresented: $showEngInsights) { EngInsightsView() }
                    .sheet(isPresented: $showLabels) { LabelsView() }
                    .sheet(item: $labelPickerTask) { LabelPickerView(task: $0) }
                    .onReceive(NotificationCenter.default.publisher(for: .loopkeeperDidMutate)) { _ in
                        Task { await model.refresh() }
                    }
                    .onReceive(NotificationCenter.default.publisher(for: .loopkeeperOpenTask)) { note in
                        if let id = note.userInfo?["taskId"] as? String {
                            Task { await model.refreshTasks(); selectedTask = model.engineeringTasks.first { $0.id == id } }
                        }
                    }
                    .alert(
                        "Something went wrong",
                        isPresented: Binding(get: { model.errorMessage != nil }, set: { if !$0 { model.errorMessage = nil } })
                    ) {
                        Button("OK", role: .cancel) {}
                    } message: {
                        Text(model.errorMessage ?? "")
                    }
            }
            .navigationTitle("")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    NavigationLink { SettingsView() } label: { Image(systemName: "gearshape") }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { Task { await model.scan() } } label: {
                        if model.isScanning { ProgressView() } else { Image(systemName: "arrow.triangle.2.circlepath") }
                    }
                    .disabled(model.isScanning)
                }
                ToolbarItem(placement: .topBarTrailing) { actionsMenu }
            }
            .safeAreaInset(edge: .bottom) {
                VStack(spacing: 0) {
                    undoToast
                    freshnessBar
                }
                .animation(.spring(duration: 0.3), value: model.lastActionLabel)
            }
        }
    }

    @ViewBuilder private var undoToast: some View {
        if let label = model.lastActionLabel {
            HStack(spacing: 12) {
                Text(label).font(.subheadline)
                Spacer()
                Button("Undo") { Task { await model.undo() } }.font(.subheadline.weight(.semibold))
                Button { model.lastActionLabel = nil } label: { Image(systemName: "xmark") }
                    .foregroundStyle(.secondary).accessibilityLabel("Dismiss")
            }
            .padding(.horizontal, 14).padding(.vertical, 10)
            .background(.regularMaterial, in: Capsule())
            .padding(.horizontal)
            .padding(.bottom, 6)
            .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }

    private var actionsMenu: some View {
        Menu {
            Picker("Sort", selection: $sortByPriority) {
                Label("By date", systemImage: "calendar").tag(false)
                Label("By priority", systemImage: "exclamationmark.triangle").tag(true)
            }
            Divider()
            Button { showInsights = true } label: { Label("Insights", systemImage: "chart.bar") }
            Button { showEngInsights = true } label: { Label("Eng insights", systemImage: "cpu") }
            Button { showLabels = true } label: { Label("Manage labels", systemImage: "tag") }
            Button { showPeople = true } label: { Label("People", systemImage: "person.2") }
            Divider()
            Button { showStandup = true } label: { Label("Standup roll-up", systemImage: "text.append") }
            Button { showWeekly = true } label: { Label("Weekly review", systemImage: "calendar.badge.clock") }
            Button { showShutdown = true } label: { Label("Wind down", systemImage: "moon.zzz") }
            Divider()
            Button { showArchive = true } label: { Label("Completed", systemImage: "checkmark.circle") }
            Button { showBragDoc = true } label: { Label("Brag doc", systemImage: "rosette") }
        } label: {
            Image(systemName: "ellipsis.circle")
        }
    }

    // MARK: task filter

    private var filterTagsSet: Set<String> {
        Set(filterTagsCSV.split(separator: ",").map(String.init).filter { !$0.isEmpty })
    }

    private var filteredSortedTasks: [EngTask] {
        applyTaskFilters(model.sortedTasks, filter: TaskFilterState(
            stage: filterStage,
            statusGroup: filterStatus,
            tags: filterTagsSet
        ))
    }

    private var availableTags: [String] { availableTaskTags(model.engineeringTasks) }

    /// Tasks for the active queue label in saved position order.
    private var queueTasks: [EngTask] {
        guard !queueLabelId.isEmpty, !model.queueOrder.isEmpty else { return [] }
        let byJiraId = Dictionary(
            uniqueKeysWithValues: model.engineeringTasks.compactMap { t -> (String, EngTask)? in
                guard let jid = t.jiraId else { return nil }
                return (jid, t)
            }
        )
        return model.queueOrder.compactMap { byJiraId[$0] }
    }

    private var hasActiveFilters: Bool {
        filterStage != "all" || filterStatus != "any" || !filterTagsCSV.isEmpty
    }

    private func toggleTag(_ tag: String) {
        var tags = filterTagsSet
        if tags.contains(tag) { tags.remove(tag) } else { tags.insert(tag) }
        filterTagsCSV = tags.sorted().joined(separator: ",")
    }

    private var taskFilterMenu: some View {
        Menu {
            Picker("Stage", selection: $filterStage) {
                Text("all stages").tag("all")
                ForEach(engStages, id: \.self) { Text($0).tag($0) }
            }
            Picker("Status", selection: $filterStatus) {
                Text("any status").tag("any")
                Text("needs you").tag("needs-you")
                Text("running").tag("running")
                Text("blocked").tag("blocked")
                Text("done").tag("done")
            }
            if !availableTags.isEmpty {
                Divider()
                Section("Tags") {
                    ForEach(availableTags, id: \.self) { tag in
                        Button { toggleTag(tag) } label: {
                            if filterTagsSet.contains(tag) {
                                Label(tag, systemImage: "checkmark")
                            } else {
                                Text(tag)
                            }
                        }
                    }
                }
            }
            if hasActiveFilters {
                Divider()
                Button("clear filters", role: .destructive) {
                    filterStage   = "all"
                    filterStatus  = "any"
                    filterTagsCSV = ""
                }
            }
        } label: {
            Image(systemName: hasActiveFilters
                ? "line.3.horizontal.decrease.circle.fill"
                : "line.3.horizontal.decrease.circle")
                .font(.system(size: 10))
                .foregroundStyle(Theme.headerAccent)
        }
    }

    // MARK: content states

    @ViewBuilder private var content: some View {
        if !searchText.trimmingCharacters(in: .whitespaces).isEmpty {
            searchList
        } else if !model.isEmpty || !model.engineeringTasks.isEmpty || model.jiraConnected {
            briefList
        } else if model.isLoading {
            ProgressView(model.isScanning ? "Scanning for new commitments…" : "Loading your loops…")
        } else if !model.hasConnections {
            OnboardingView()
        } else {
            ContentUnavailableView(
                "Nothing slips",
                systemImage: "checkmark.circle",
                description: Text("You're all caught up. Pull to refresh, or tap ↻ to scan for new commitments.")
            )
        }
    }

    private var searchList: some View {
        List {
            if searchResults.isEmpty {
                ContentUnavailableView.search(text: searchText)
            } else {
                Section {
                    ForEach(searchResults) { row($0) }
                } header: {
                    terminalHeader("# results", searchResults.count)
                }
            }
        }
        .listStyle(.plain)
    }

    private var briefList: some View {
        List {
            if !focusNow.isEmpty {
                Section {
                    if !isCollapsed("focus") { ForEach(focusNow) { row($0) } }
                } header: {
                    Button {
                        withAnimation(.easeInOut(duration: 0.15)) { toggleCollapsed("focus") }
                    } label: {
                        HStack(spacing: 6) { collapseChevron("focus"); terminalHeader("# focus", focusNow.count) }
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
            if !model.engineeringTasks.isEmpty || model.jiraConnected {
                Section {
                    if !isCollapsed("tasks") {
                        if !queueLabelId.isEmpty {
                            // Queue mode: tasks for the active label in saved order, drag-to-reorder.
                            ForEach(queueTasks) { task in
                                JiraTaskRow(task: task, labels: model.labels)
                                    .listRowSeparator(.visible)
                                    .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
                                    .contentShape(Rectangle())
                                    .onTapGesture { Haptics.tap(); selectedTask = task }
                                    .swipeActions(edge: .leading) {
                                        Button { labelPickerTask = task } label: { Label("Labels", systemImage: "tag") }.tint(.purple)
                                    }
                            }
                            .onMove { indices, dest in
                                var ids = model.queueOrder
                                ids.move(fromOffsets: indices, toOffset: dest)
                                Task { await model.reorderLabel(labelId: queueLabelId, jiraIds: ids) }
                            }
                            if queueTasks.isEmpty {
                                Text("no tasks in this queue yet — attach a label from a task row")
                                    .font(.system(size: 11, design: .monospaced))
                                    .foregroundStyle(.tertiary)
                                    .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
                            }
                        } else {
                            ForEach(filteredSortedTasks) { task in
                                JiraTaskRow(task: task, labels: model.labels)
                                    .listRowSeparator(.visible)
                                    .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
                                    .contentShape(Rectangle())
                                    .onTapGesture { Haptics.tap(); selectedTask = task }
                                    .swipeActions(edge: .leading) {
                                        Button { labelPickerTask = task } label: { Label("Labels", systemImage: "tag") }.tint(.purple)
                                    }
                            }
                            if filteredSortedTasks.isEmpty {
                                Text(hasActiveFilters
                                    ? "no tasks match — clear filters"
                                    : (model.isSyncingTasks ? "syncing from jira…" : "no tasks assigned — tap sync to check jira"))
                                    .font(.system(size: 11, design: .monospaced))
                                    .foregroundStyle(.tertiary)
                                    .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
                            }
                        }
                    }
                } header: {
                    tasksHeader
                }
            }
            if let brief = model.brief {
                section(.overdue, sorted(brief.overdue))
                section(.today, sorted(brief.today))
                section(.upcoming, sorted(brief.upcoming))
                section(.noDate, sorted(brief.noDate))
                section(.awaiting, sorted(brief.awaiting))
            }
        }
        .listStyle(.plain)
        .environment(\.defaultMinListRowHeight, 0)
        .animation(.default, value: model.brief?.date)
    }

    /// The top 3 owe-loops by priority across overdue/today/upcoming — the morning's first answer.
    private var focusNow: [OpenLoop] {
        guard let brief = model.brief else { return [] }
        return (brief.overdue + brief.today + brief.upcoming)
            .sorted { $0.priorityScore > $1.priorityScore }
            .prefix(3)
            .map { $0 }
    }

    @ViewBuilder
    private func section(_ bucket: Theme.Bucket, _ loops: [OpenLoop]) -> some View {
        if !loops.isEmpty {
            Section {
                if !isCollapsed(headerKey(bucket)) {
                    ForEach(bucket == .noDate ? noDateVisible(loops, expanded: noDateExpanded) : loops) { row($0) }
                    if bucket == .noDate && loops.count > 10 {
                        noDateToggleRow(total: loops.count)
                    }
                }
            } header: {
                sectionHeader(bucket, loops)
            }
        }
    }

    @ViewBuilder
    private func noDateToggleRow(total: Int) -> some View {
        Button {
            withAnimation(.easeInOut(duration: 0.15)) { noDateExpanded.toggle() }
        } label: {
            Text(noDateExpanded ? "Show less" : "Show all (\(total))")
                .font(.system(size: 12, design: .monospaced))
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(.plain)
        .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
        .listRowSeparator(.hidden)
    }

    @ViewBuilder
    private func row(_ loop: OpenLoop) -> some View {
        LoopRow(loop: loop)
            .listRowSeparator(.visible)
            .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
            .contentShape(Rectangle())
            .onTapGesture { Haptics.tap(); selected = loop }
            .swipeActions(edge: .trailing) {
                Button { Task { await model.markDone(loop) } } label: { Label("Done", systemImage: "checkmark") }.tint(.green)
                Button { Task { await model.snooze(loop, days: 1) } } label: { Label("Snooze", systemImage: "clock") }.tint(.orange)
            }
            .swipeActions(edge: .leading) {
                Button(role: .destructive) { Task { await model.dismiss(loop) } } label: { Label("Dismiss", systemImage: "trash") }
            }
            .contextMenu { rowMenu(loop) }
    }

    @ViewBuilder
    private func sectionHeader(_ bucket: Theme.Bucket, _ loops: [OpenLoop]) -> some View {
        let key = headerKey(bucket)
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Button {
                withAnimation(.easeInOut(duration: 0.15)) { toggleCollapsed(key) }
            } label: {
                HStack(spacing: 6) {
                    collapseChevron(key)
                    Text("# \(key)")
                        .font(.system(size: 12, weight: .semibold, design: .monospaced))
                        .foregroundStyle(Theme.headerAccent)
                    Text("\(loops.count)")
                        .font(.system(size: 12, design: .monospaced))
                        .foregroundStyle(.secondary)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            Spacer()
            if bucket == .overdue || bucket == .today {
                Menu {
                    Button("Tomorrow") { Task { await model.snoozeAll(loops, days: 1) } }
                    Button("In 3 days") { Task { await model.snoozeAll(loops, days: 3) } }
                    Button("Next week") { Task { await model.snoozeAll(loops, days: 7) } }
                } label: {
                    Text("snooze all").font(.system(size: 11, design: .monospaced)).foregroundStyle(.secondary)
                }
            }
        }
        .textCase(nil)
    }

    /// Lowercase one-word terminal key for a bucket header (`overdue`, `today`, `waiting`…).
    private func headerKey(_ bucket: Theme.Bucket) -> String {
        switch bucket {
        case .overdue: "overdue"
        case .today: "today"
        case .upcoming: "upcoming"
        case .noDate: "no date"
        case .awaiting: "waiting"
        }
    }

    // MARK: collapsible sections

    private func isCollapsed(_ key: String) -> Bool {
        collapsedCSV.split(separator: ",").contains(Substring(key))
    }
    private func toggleCollapsed(_ key: String) {
        var set = Set(collapsedCSV.split(separator: ",").map(String.init))
        if set.contains(key) { set.remove(key) } else { set.insert(key) }
        collapsedCSV = set.sorted().joined(separator: ",")
    }
    @ViewBuilder private func collapseChevron(_ key: String) -> some View {
        Image(systemName: isCollapsed(key) ? "chevron.right" : "chevron.down")
            .font(.system(size: 9, weight: .semibold)).foregroundStyle(.tertiary).frame(width: 10)
    }

    /// Plain monospaced section header: `# key   N   <trailing>`.
    @ViewBuilder
    private func terminalHeader(_ title: String, _ count: Int? = nil, trailing: String? = nil, trailingTint: Color = .secondary) -> some View {
        HStack(spacing: 8) {
            Text(title)
                .font(.system(size: 12, weight: .semibold, design: .monospaced))
                .foregroundStyle(Theme.headerAccent)
            if let count {
                Text("\(count)").font(.system(size: 12, design: .monospaced)).foregroundStyle(.secondary)
            }
            Spacer()
            if let trailing {
                Text(trailing).font(.system(size: 11, design: .monospaced)).foregroundStyle(trailingTint)
            }
        }
        .textCase(nil)
    }

    /// `# tasks` header with a dedicated Jira-sync action. Pull-to-refresh stays cheap (re-read only);
    /// this `[ sync ]` button is the one control that pulls newly-assigned tickets from Jira.
    @ViewBuilder
    private var tasksHeader: some View {
        let badgeCount = filteredSortedTasks.filter(\.needsAction).count
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Button {
                    withAnimation(.easeInOut(duration: 0.15)) { toggleCollapsed("tasks") }
                } label: {
                    HStack(spacing: 6) {
                        collapseChevron("tasks")
                        Text("# tasks")
                            .font(.system(size: 12, weight: .semibold, design: .monospaced))
                            .foregroundStyle(Theme.headerAccent)
                        if queueLabelId.isEmpty, badgeCount > 0 {
                            Text("\(badgeCount) need you")
                                .font(.system(size: 11, design: .monospaced))
                                .foregroundStyle(.orange)
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                Spacer()
                if queueLabelId.isEmpty {
                    if filterStage != "all" {
                        Text("[\(filterStage)]")
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundStyle(Theme.headerAccent)
                    }
                    taskFilterMenu
                }
                queueLabelMenu
                Button { Task { await model.syncTasks() } } label: {
                    HStack(spacing: 5) {
                        if model.isSyncingTasks {
                            ProgressView().controlSize(.mini)
                        } else {
                            Image(systemName: "arrow.triangle.2.circlepath").font(.system(size: 10))
                        }
                        Text(model.isSyncingTasks ? "syncing" : "sync")
                            .font(.system(size: 11, design: .monospaced))
                    }
                    .foregroundStyle(model.isSyncingTasks ? Color.secondary : Theme.headerAccent)
                }
                .buttonStyle(.plain)
                .disabled(model.isSyncingTasks)
            }
        }
        .textCase(nil)
    }

    /// Menu to pick (or clear) the active queue label.
    @ViewBuilder private var queueLabelMenu: some View {
        Menu {
            Button {
                queueLabelId = ""
                model.queueOrder = []
            } label: {
                if queueLabelId.isEmpty {
                    Label("All tasks", systemImage: "checkmark")
                } else {
                    Text("All tasks")
                }
            }
            if !model.labels.isEmpty {
                Divider()
                ForEach(model.labels) { lbl in
                    Button {
                        queueLabelId = lbl.id
                        Task { await model.loadLabelOrder(lbl.id) }
                    } label: {
                        if queueLabelId == lbl.id {
                            Label(lbl.name, systemImage: "checkmark")
                        } else {
                            Text(lbl.name)
                        }
                    }
                }
            }
        } label: {
            Image(systemName: queueLabelId.isEmpty ? "tag" : "tag.fill")
                .font(.system(size: 10))
                .foregroundStyle(queueLabelId.isEmpty ? Theme.headerAccent : Theme.labelColor(model.label(queueLabelId)?.color ?? ""))
        }
    }

    @ViewBuilder
    private func rowMenu(_ loop: OpenLoop) -> some View {
        Button { Task { await model.markDone(loop) } } label: { Label("Mark done", systemImage: "checkmark.circle") }
        Menu {
            Button("Tomorrow") { Task { await model.snooze(loop, days: 1) } }
            Button("In 3 days") { Task { await model.snooze(loop, days: 3) } }
            Button("Next week") { Task { await model.snooze(loop, days: 7) } }
        } label: {
            Label("Snooze", systemImage: "clock")
        }
        if loop.sourceWebURL != nil {
            Button { openLoopSource(loop, using: openURL) } label: { Label("View in \(Theme.channelLabel(loop.channel))", systemImage: "arrow.up.right.square") }
        }
        Divider()
        Button(role: .destructive) { Task { await model.dismiss(loop) } } label: { Label("Dismiss", systemImage: "trash") }
    }

    // MARK: banners + freshness

    @ViewBuilder private var warningBanner: some View {
        if !model.scanWarnings.isEmpty {
            let critical = model.scanWarnings.contains { $0.localizedCaseInsensitiveContains("unavailable") || $0.localizedCaseInsensitiveContains("failed") }
            let tint = critical ? Color.red : Color.orange
            HStack(alignment: .top, spacing: 8) {
                Text("!").font(.system(size: 12, weight: .bold, design: .monospaced)).foregroundStyle(tint)
                VStack(alignment: .leading, spacing: 3) {
                    ForEach(model.scanWarnings, id: \.self) { warning in
                        Text(warning).font(.system(size: 11, design: .monospaced)).foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 4)
                Button { model.scanWarnings = [] } label: {
                    Image(systemName: "xmark").font(.system(size: 11)).foregroundStyle(.secondary)
                }
                .accessibilityLabel("Dismiss warning")
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            .background(tint.opacity(0.08))
        }
    }

    @ViewBuilder private var freshnessBar: some View {
        if let updated = model.lastUpdated, !model.isEmpty {
            Text("Updated \(updated, style: .time)")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 4)
                .background(.bar)
        }
    }

    /// Sort a bucket by the active mode: priority score (desc) or due date (asc, undated last).
    private func sorted(_ loops: [OpenLoop]) -> [OpenLoop] {
        if sortByPriority { return loops.sorted { $0.priorityScore > $1.priorityScore } }
        return loops.sorted { a, b in
            switch (a.dueDate, b.dueDate) {
            case let (x?, y?): return x < y
            case (_?, nil): return true
            case (nil, _?): return false
            default: return false
            }
        }
    }
}
