import SwiftUI

/// Stage theming for the engineering pipeline (Phase 2). String-keyed so an unknown backend value
/// degrades gracefully instead of failing to render.
extension Theme {
    static func stageTitle(_ stage: String) -> String {
        switch stage {
        case "plan": "Plan"
        case "dev": "Dev"
        case "test": "Test"
        case "pr": "PR"
        case "review": "Review"
        case "merge": "Merge"
        case "deploy": "Deploy"
        default: stage.capitalized
        }
    }

    static func stageIcon(_ stage: String) -> String {
        switch stage {
        case "plan": "list.clipboard"
        case "dev": "chevron.left.forwardslash.chevron.right"
        case "test": "checkmark.diamond"
        case "pr": "arrow.triangle.pull"
        case "review": "bubble.left.and.bubble.right"
        case "merge": "arrow.triangle.merge"
        case "deploy": "shippingbox"
        default: "circle"
        }
    }

    /// PRD §7.1 phrasing for the (stage, status) pair.
    static func statusLabel(_ stage: String, _ status: String) -> String {
        switch status {
        case "not_started": return "Not started"
        case "in_progress": return "In progress"
        case "completed_unapproved": return "Completed (not approved)"
        case "approved": return "Approved"
        case "done": return "Done"
        case "passed": return "Passed"
        case "failed": return stage == "deploy" ? "Deploy failed" : "Tests failed"
        case "proposed": return "Proposed"
        case "creating": return "Opening…"
        case "created": return "Created"
        case "awaiting_review": return "Awaiting review"
        case "comments_received": return "Comments received"
        case "comments_addressed": return "Comments addressed"
        case "ready": return "Ready to merge"
        case "merging": return "Merging…"
        case "merged": return "Merged"
        case "deploying": return "Deploying…"
        case "deployed": return "Deployed"
        case "blocked": return "Needs attention"
        case "cancelled": return "Cancelled"
        default: return status.capitalized
        }
    }

    /// Accent by status: red for failures, orange for "needs a human", blue while running, green for good.
    static func stageAccent(_ status: String) -> Color {
        switch status {
        case "failed", "blocked": return .red
        case "completed_unapproved", "proposed", "ready", "comments_received": return .orange
        case "in_progress", "creating", "merging", "deploying", "comments_addressed": return .blue
        case "approved", "done", "passed", "merged", "deployed", "created", "awaiting_review": return .green
        default: return .clear
        }
    }

    static func stageDot(_ status: String) -> String {
        switch status {
        case "not_started": "circle"
        case "in_progress", "creating", "merging", "deploying", "comments_addressed": "circle.dotted"
        case "failed", "blocked": "xmark.circle.fill"
        case "completed_unapproved", "proposed", "ready", "comments_received": "exclamationmark.circle.fill"
        case "cancelled": "minus.circle"
        default: "checkmark.circle.fill"
        }
    }
}
