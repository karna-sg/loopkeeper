import Foundation

/// Mirrors the backend `EngTask` JSON (camelCase 1:1). `stage`/`status` are kept as `String` so an
/// unknown value from a newer backend never crashes the decoder; sub-artifacts are all optional.

let engStages = ["plan", "dev", "test", "pr", "review", "merge", "deploy", "verify"]

struct PlanArtifact: Codable, Hashable {
    let text: String?
    let editedText: String?
    let sessionId: String?
    let revision: Int?
    let approvedBy: String?
}

struct DevArtifact: Codable, Hashable {
    let summary: String?
    let branch: String?
    let branchURL: String?
    let filesChanged: Int?
    let iterations: Int?
}

struct TestRun: Codable, Hashable {
    let ts: String?
    let passed: Bool?
    let total: Int?
    let failed: Int?
    let summary: String?
}

struct TestArtifact: Codable, Hashable {
    let runs: [TestRun]?
    let lastPassed: Bool?
}

struct PRArtifact: Codable, Hashable {
    let title: String?
    let body: String?
    let diffSummary: String?
    let url: String?
    let number: Int?
}

struct ReviewComment: Codable, Identifiable, Hashable {
    let externalId: String
    let author: String?
    let body: String?
    let path: String?
    let resolution: String?
    var id: String { externalId }
}

struct ReviewArtifact: Codable, Hashable {
    let comments: [ReviewComment]?
    let approved: Bool?
    let rounds: Int?
}

struct MergeArtifact: Codable, Hashable {
    let commitSha: String?
    let mergedTs: String?
    let method: String?
}

struct DeployArtifact: Codable, Hashable {
    let env: String?
    let status: String?
    let logTail: String?
    let commitSha: String?
    /// GitHub Actions deploy-run URL (CD pipeline observed for the merge commit).
    let runUrl: String?
    /// CI (verify) job conclusion — "success" / "failure" / nil while running.
    let ci: String?
    /// CD (deploy) job conclusion.
    let cd: String?
}

struct VerifyCheck: Codable, Hashable {
    let name: String?
    let ok: Bool?
    let detail: String?
}

struct VerifyArtifact: Codable, Hashable {
    let deployedSha: String?
    let changeSummary: String?
    let healthOk: Bool?
    let checks: [VerifyCheck]?
    let output: String?
    let runUrl: String?
    let verifiedBy: String?
    let verifiedTs: String?
}

struct RollbackArtifact: Codable, Hashable {
    let targetSha: String?
    let revertSha: String?
    let prUrl: String?
    let status: String?
    let logTail: String?
}

struct TaskArtifacts: Codable, Hashable {
    let plan: PlanArtifact?
    let dev: DevArtifact?
    let test: TestArtifact?
    let pr: PRArtifact?
    let review: ReviewArtifact?
    let merge: MergeArtifact?
    let deploy: DeployArtifact?
    let verify: VerifyArtifact?
    let rollback: RollbackArtifact?
}

struct TaskBudget: Codable, Hashable {
    let maxIterations: Int?
    let iterationsUsed: Int?
    let maxUsdCents: Int?
    let usdCentsUsed: Int?
}

/// A Jira engineering task tracked through the LoopKeeper lifecycle.
struct EngTask: Codable, Identifiable, Hashable {
    let id: String
    let jiraKey: String
    let jiraUrl: String?
    let title: String
    let description: String?
    let acceptanceCriteria: String?
    let labels: [String]?
    let components: [String]?
    let jiraStatus: String?
    let repo: String?
    let branch: String?
    let stage: String
    let status: String
    let artifacts: TaskArtifacts?
    let budget: TaskBudget?
    let lastError: String?
    let updatedTs: String?

    /// Waiting on a human (gate ready or escalated). Drives the Home badge + sort priority.
    var needsAction: Bool {
        if status == "blocked" { return true }
        switch "\(stage):\(status)" {
        case "plan:completed_unapproved", "pr:proposed", "review:awaiting_review", "review:comments_received", "review:comments_addressed", "merge:ready", "deploy:failed",
             "verify:awaiting_review", "verify:failed", "rollback:ready", "rollback:failed":
            return true
        default:
            return false
        }
    }

    /// A stage is actively executing on the worker.
    var isRunning: Bool { ["in_progress", "creating", "merging", "deploying"].contains(status) }
}

/// One immutable timeline entry (FR-7).
struct StageEvent: Codable, Identifiable, Hashable {
    let seq: Int
    let fromStage: String?
    let fromStatus: String?
    let toStage: String
    let toStatus: String
    let actor: String
    let note: String?
    let gateApproved: Bool?
    let ts: String
    var id: Int { seq }
}

/// `GET /tasks`.
struct TasksResponse: Codable { let tasks: [EngTask] }

/// `GET /tasks/:id`.
struct TaskDetailResponse: Codable { let task: EngTask; let events: [StageEvent] }

/// `GET /tasks/:id/status` — the poll payload (mirrors ScanStatus).
struct TaskStatusResponse: Codable {
    let id: String
    let stage: String
    let status: String
    let runState: String   // "running" | "stalled" | "idle"
    let iteration: Int?
    let usdCents: Int?
    let lastError: String?
}

/// Jira/repo config form (`GET`/`PUT /jira/config` — surfaced read-only in v1 from health/env).
struct JiraSettings: Codable {
    let repo: String?
    let baseBranch: String?
    let projectKey: String?
}

// MARK: - Diff models (GET /tasks/:id/diff)

struct DiffLine: Codable {
    /// `+` = addition, `-` = deletion, ` ` = context
    let type: String
    let text: String
}

struct DiffHunk: Codable {
    let header: String
    let lines: [DiffLine]
}

struct DiffFile: Codable, Identifiable {
    let path: String
    let status: String
    let additions: Int?
    let deletions: Int?
    let hunks: [DiffHunk]
    var id: String { path }
}

/// `GET /tasks/:id/diff`
struct DiffResponse: Decodable {
    let files: [DiffFile]
    let truncated: Bool
}
