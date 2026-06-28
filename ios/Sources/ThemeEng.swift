import SwiftUI

/// Stage theming for the engineering pipeline (Phase 2). String-keyed so an unknown backend value
/// degrades gracefully instead of failing to render.
///
/// Terminal-clean variant: status reads as terse monospaced TEXT tokens, not colored capsule pills.
/// Color is restrained — a single dim accent (and only red/orange when a human is actually needed).
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
        case "verify": "Verify"
        case "rollback": "Rollback"
        default: stage.capitalized
        }
    }

    /// Lowercase, fixed-width stage key for monospaced lists/trees: `plan    `, `rollback`.
    /// Pad to the width of the widest key ("rollback" = 8) so columns line up.
    static func stageKey(_ stage: String) -> String {
        let key = (stage == "pr") ? "pr" : stage.lowercased()
        return key.padding(toLength: 8, withPad: " ", startingAt: 0)
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
        case "verify": "checkmark.seal"
        case "rollback": "arrow.uturn.backward"
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
        case "failed":
            switch stage {
            case "deploy": return "Deploy failed"
            case "verify": return "Verification failed"
            case "rollback": return "Rollback failed"
            default: return "Tests failed"
            }
        case "proposed": return "Proposed"
        case "creating": return "Opening…"
        case "created": return "Created"
        case "awaiting_review": return stage == "verify" ? "Deployed — confirm" : "Awaiting review"
        case "comments_received": return "Comments received"
        case "comments_addressed": return "Comments addressed"
        case "ready": return stage == "rollback" ? "Ready to roll back" : "Ready to merge"
        case "merging": return "Merging…"
        case "merged": return "Merged"
        case "deploying": return "Deploying…"
        case "deployed": return "Deployed"
        case "verified": return "Verified"
        case "rolled_back": return "Rolled back"
        case "blocked": return "Needs attention"
        case "cancelled": return "Cancelled"
        default: return status.capitalized
        }
    }

    /// Terse lowercase token for a dense list line, e.g. `awaiting`, `running`, `failed`, `merged`.
    static func statusToken(_ stage: String, _ status: String) -> String {
        switch status {
        case "not_started": return "queued"
        case "in_progress":
            switch stage {
            case "verify": return "verifying"
            case "rollback": return "reverting"
            default: return "running"
            }
        case "completed_unapproved": return "awaiting"
        case "approved": return "approved"
        case "done": return "done"
        case "passed": return "passed"
        case "failed":
            switch stage {
            case "deploy": return "deploy fail"
            case "verify": return "verify fail"
            case "rollback": return "rollback fail"
            default: return "failed"
            }
        case "proposed": return "awaiting"
        case "creating": return "opening"
        case "created": return "created"
        case "awaiting_review": return stage == "verify" ? "confirm" : "in review"
        case "comments_received": return "comments"
        case "comments_addressed": return "addressed"
        case "ready": return stage == "rollback" ? "armed" : "awaiting"
        case "merging": return "merging"
        case "merged": return "merged"
        case "deploying": return "deploying"
        case "deployed": return "deployed"
        case "verified": return "verified"
        case "rolled_back": return "rolled back"
        case "blocked": return "blocked"
        case "cancelled": return "cancelled"
        default: return status.lowercased()
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

    /// Restrained text color for a status token. Neutral by default; color is earned only by a
    /// failure (red), a pending human gate (orange), or live activity (dim blue). Completed work is
    /// intentionally NOT green text — it stays neutral so the eye lands on what needs attention.
    static func statusTint(_ status: String) -> Color {
        switch status {
        case "failed", "blocked": return .red
        case "completed_unapproved", "proposed", "ready", "comments_received": return .orange
        case "in_progress", "creating", "merging", "deploying", "comments_addressed": return .blue
        default: return secondary
        }
    }

    /// Color for the status tick/glyph: GREEN for success, RED for failure, orange for a pending
    /// human gate, blue while running, neutral when not started. Used for the ✓/✗ marks on Home rows
    /// and pipeline stages so success/failure read at a glance.
    static func tickTint(_ status: String) -> Color {
        switch status {
        case "failed", "blocked", "cancelled": return .red
        case "in_progress", "creating", "merging", "deploying", "comments_addressed": return .blue
        case "completed_unapproved", "proposed", "ready", "comments_received", "awaiting_review": return .orange
        case "approved", "done", "passed", "created", "merged", "deployed", "verified", "rolled_back": return .green
        default: return secondary
        }
    }

    /// A one-glyph terminal marker for a stage's state: `✓` done, `…` running, `✗` failed,
    /// `●` needs you, `·` not started. Pure text, monospaced-friendly.
    static func stageGlyph(_ status: String) -> String {
        switch status {
        case "not_started", "queued": return "·"
        case "in_progress", "creating", "merging", "deploying", "comments_addressed": return "…"
        case "failed", "blocked": return "✗"
        case "completed_unapproved", "proposed", "ready", "comments_received": return "●"
        case "cancelled": return "–"
        default: return "✓"
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
