import Foundation

/// Backend location + auth, configurable in Settings (LAN IP / tunnel + token for a real device).
enum AppConfig {
    static let backendURLKey = "loopkeeper.backendURL"
    static let apiTokenKey = "loopkeeper.apiToken"

    static var baseURL: URL {
        let stored = UserDefaults.standard.string(forKey: backendURLKey)
        return URL(string: stored ?? "http://127.0.0.1:8787") ?? URL(string: "http://127.0.0.1:8787")!
    }

    static var apiToken: String? {
        let t = UserDefaults.standard.string(forKey: apiTokenKey)
        return (t?.isEmpty == false) ? t : nil
    }
}

struct APIError: Error, LocalizedError {
    let status: Int
    let message: String?
    var errorDescription: String? { message ?? "Backend returned HTTP \(status)" }
}

/// Thin async client over the Loopkeeper REST API. Read + lifecycle only — no send path.
struct APIClient {
    var baseURL: URL
    var token: String?

    init(baseURL: URL = AppConfig.baseURL, token: String? = AppConfig.apiToken) {
        self.baseURL = baseURL
        self.token = token
    }

    func health() async throws -> Health { try await getJSON("/healthz") }
    func brief() async throws -> Brief { try await getJSON("/brief") }
    func loops(status: String? = nil, q: String? = nil) async throws -> [OpenLoop] {
        var items: [String] = []
        if let status { items.append("status=\(status)") }
        if let q, !q.isEmpty, let enc = q.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) { items.append("q=\(enc)") }
        return try await getJSON("/loops" + (items.isEmpty ? "" : "?" + items.joined(separator: "&")))
    }

    /// Starts a scan in the background; returns immediately (the server keeps running it).
    func startScan(days: Int) async throws {
        let req = makeRequest("/scan?days=\(days)", method: "POST", json: false)
        _ = try await run(req)
    }

    func scanStatus() async throws -> ScanStatus { try await getJSON("/scan/status") }

    func registerDevice(_ token: String) async throws { try await act("/devices", body: ["token": token]) }
    func markDone(_ id: String) async throws { try await act("/loops/\(id)/done") }
    func dismiss(_ id: String) async throws { try await act("/loops/\(id)/dismiss") }
    func confirmClose(_ id: String) async throws { try await act("/loops/\(id)/confirm-close") }
    func notALoop(_ id: String) async throws { try await act("/loops/\(id)/not-a-loop") }
    func delegate(_ id: String, to: String) async throws { try await act("/loops/\(id)/delegate", body: ["to": to]) }
    func stats() async throws -> Stats { try await getJSON("/stats") }
    func undo() async throws { try await act("/undo") }
    func recur(_ id: String, rule: String) async throws { try await act("/loops/\(id)/recur", body: ["rule": rule]) }
    func snoozeUntilReply(_ id: String) async throws { try await act("/loops/\(id)/snooze", body: ["condition": "reply"]) }

    func organize(_ id: String, project: String?, tags: [String]) async throws {
        struct Body: Encodable { let project: String?; let tags: [String] }
        var req = makeRequest("/loops/\(id)/organize", method: "POST", json: true)
        req.httpBody = try JSONEncoder().encode(Body(project: project, tags: tags))
        _ = try await run(req)
    }

    func exportData() async throws -> String {
        String(decoding: try await run(makeRequest("/export", method: "GET", json: false)), as: UTF8.self)
    }
    func label(_ id: String, _ value: String) async throws { try await act("/loops/\(id)/label", body: ["label": value]) }
    func snooze(_ id: String, untilISO: String) async throws { try await act("/loops/\(id)/snooze", body: ["until": untilISO]) }

    func draft(_ id: String) async throws -> String {
        struct Response: Decodable { let draft: String }
        let response: Response = try await getJSON("/loops/\(id)/draft")
        return response.draft
    }

    func reset() async throws { try await act("/reset") }

    func channels() async throws -> ChannelsResponse { try await getJSON("/channels") }

    func saveConfig(_ update: ConfigUpdate) async throws {
        var req = makeRequest("/config", method: "PUT", json: true)
        req.httpBody = try JSONEncoder().encode(update)
        _ = try await run(req)
    }

    // MARK: - Engineering (Phase 2)

    func tasks() async throws -> [EngTask] {
        let r: TasksResponse = try await getJSON("/tasks")
        return r.tasks
    }
    func taskDetail(_ id: String) async throws -> TaskDetailResponse { try await getJSON("/tasks/\(id)") }
    func taskStatus(_ id: String) async throws -> TaskStatusResponse { try await getJSON("/tasks/\(id)/status") }
    func syncTasks() async throws { try await act("/tasks/sync") }

    func preparePlan(_ id: String) async throws { try await act("/tasks/\(id)/prepare-plan") }
    func approvePlan(_ id: String, editedText: String?) async throws {
        try await act("/tasks/\(id)/plan/approve", body: editedText.map { ["editedText": $0] })
    }
    func revisePlan(_ id: String, note: String) async throws { try await act("/tasks/\(id)/plan/revise", body: ["note": note]) }
    func approvePR(_ id: String) async throws { try await act("/tasks/\(id)/pr/approve") }
    func addressComments(_ id: String) async throws { try await act("/tasks/\(id)/review/address-comments") }
    func approveReview(_ id: String) async throws { try await act("/tasks/\(id)/review/approve") }
    func approveMerge(_ id: String, method: String = "squash") async throws { try await act("/tasks/\(id)/merge/approve", body: ["method": method]) }
    func retryTask(_ id: String) async throws { try await act("/tasks/\(id)/retry") }
    func cancelTask(_ id: String) async throws { try await act("/tasks/\(id)/cancel") }
    func confirmVerify(_ id: String) async throws { try await act("/tasks/\(id)/verify/confirm") }
    func retryVerify(_ id: String) async throws { try await act("/tasks/\(id)/verify/retry") }
    func rollback(_ id: String) async throws { try await act("/tasks/\(id)/rollback") }

    // MARK: - transport

    private func makeRequest(_ path: String, method: String, json: Bool) -> URLRequest {
        var req = URLRequest(url: URL(string: baseURL.absoluteString + path)!)
        req.httpMethod = method
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if json { req.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        return req
    }

    private func run(_ req: URLRequest) async throws -> Data {
        let (data, response) = try await URLSession.shared.data(for: req)
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            throw APIError(status: http.statusCode, message: body?["error"] as? String)
        }
        return data
    }

    private func getJSON<T: Decodable>(_ path: String) async throws -> T {
        try JSONDecoder().decode(T.self, from: try await run(makeRequest(path, method: "GET", json: false)))
    }

    private func sendJSON<T: Decodable>(_ path: String, method: String) async throws -> T {
        try JSONDecoder().decode(T.self, from: try await run(makeRequest(path, method: method, json: false)))
    }

    private func act(_ path: String, body: [String: String]? = nil) async throws {
        var req = makeRequest(path, method: "POST", json: body != nil)
        if let body { req.httpBody = try JSONEncoder().encode(body) }
        _ = try await run(req)
    }
}
