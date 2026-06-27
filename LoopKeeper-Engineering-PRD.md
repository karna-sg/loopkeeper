# LoopKeeper Engineering — Product Requirements Document (PRD)

> **Status:** Draft v1 (refined from founder notes)
> **Owner:** _TBD_
> **Last updated:** 27 Jun 2026
> **Related doc:** `LoopKeeper-Engineering-Technical-Architecture.md`

---

## 1. Background

LoopKeeper is an existing iOS app that automatically generates **reminders** by reading the user's configured communication channels — Slack, Microsoft Teams, and email. It already does this reliably today.

This document defines the **next major expansion**: turning LoopKeeper from a passive reminder app into a system that can **execute software engineering tasks end to end from a phone**, without the engineer needing to sit at a physical computer.

> **One-line vision:** _"No more physical computers." Run real engineering work — plan, code, test, review, merge, deploy — from the LoopKeeper app, with a human approving the decisions that matter._

A note on terminology: the founder notes use "remainders" (= **reminders**) and "loop keeper" / "loopkeeper" (= **LoopKeeper**). This document standardizes on **reminders** and **LoopKeeper**.

---

## 2. Problem statement

Engineers lose enormous amounts of context-switching time tethered to a laptop. A large share of routine engineering work is mechanical and well-specified: take a ticket, write a plan, implement it, run tests, open a PR, address review comments, merge, and watch it deploy.

Today none of this is possible from a phone. There is no single place where an engineer can see their assigned work **and** drive it forward. LoopKeeper already owns the engineer's attention surface (reminders); the opportunity is to make it the place where the work actually gets done.

---

## 3. Goals and non-goals

### 3.1 Goals
- Let an engineer see, in one app, both their **reminders** and the **Jira tasks assigned to them**.
- Let an engineer drive a task through its full lifecycle — **plan → approve → develop → test → PR → review → merge → deploy** — from the app.
- Keep a **human in the loop** at the decisions that matter (plan approval, merge, deploy) while automating the mechanical work in between.
- Provide a **complete, auditable history** of every stage for every task.
- Run the actual engineering work on a **cloud machine**, so the phone is only a control surface.

### 3.2 Non-goals (for v1)
- Replacing the IDE for deep, exploratory, or greenfield architecture work.
- Supporting issue trackers other than Jira, or code hosts other than GitHub (planned later).
- Fully autonomous merge/deploy with **no** human approval (explicitly out of scope for v1 on safety grounds — see §8).
- Real-time pair-programming / live editing from the phone.

---

## 4. Target users & personas

| Persona | Needs from LoopKeeper Engineering |
|---|---|
| **IC engineer** (primary) | Pick up assigned Jira tickets, get a plan drafted, approve it, and let the system implement + open a PR while they do other things. |
| **Tech lead / reviewer** | See plans and PRs surfaced in-app; approve or request changes from the phone. |
| **Engineering manager** | Visibility into what's in flight, which stage each task is at, and an audit trail. |

Primary persona for v1 is the **IC engineer**.

---

## 5. High-level product overview

LoopKeeper gains a new **Engineering** capability with three pillars:

1. **Home with two sections** — reminders (existing) and *My Jira Tasks* (new).
2. **Task workspace** — a per-task screen that holds requirements and the full stage history.
3. **Execution engine** — a cloud machine that runs an AI coding agent (Claude Code) to do the work, orchestrated by a LoopKeeper backend.

The engineer's job becomes **reviewing and approving**, not typing code on a phone.

---

## 6. Functional requirements

### 6.1 Integrations & configuration
- **FR-1** Users can connect **Jira** and **GitHub** accounts to LoopKeeper (in addition to the existing Slack / Teams / email channels).
- **FR-2** After connecting Jira, LoopKeeper imports the tasks **assigned to the current user**.
- **FR-3** Connection setup must never require the user to type long-lived secrets into the app UI; authentication uses OAuth / delegated tokens (see Technical doc §7, Security).

### 6.2 Home screen
- **FR-4** The Home screen shows **two sections**:
  - **Reminders** — existing behavior, unchanged.
  - **My Jira Tasks** — all Jira issues currently assigned to the user, each showing its title, Jira key, and current **LoopKeeper stage** (see §7).
- **FR-5** Tapping a task opens its **Task workspace** (§6.3).

### 6.3 Task workspace
- **FR-6** A task opens with **all the context needed to act on it**: the Jira summary, description, acceptance criteria, linked design docs, and labels/components.
- **FR-7** The workspace displays the task's **stage history** as a timeline. Every stage transition is recorded with a timestamp, who/what triggered it, and any artifacts produced (see §7 for the stage model).
- **FR-8** Each stage stores its own **artifacts**:
  - **Plan** stage stores the full generated plan text (readable, editable, approvable).
  - **Dev** stage stores a summary of changes and a link to the branch.
  - **Test** stage stores test results / pass-fail summary.
  - **PR** stage stores the PR link, title, and description.
  - **Review** stage stores reviewer comments and how each was resolved.
  - **Merge** stage stores the merge commit / status.
  - **Deploy** stage stores deployment status and environment.

### 6.4 Plan generation & approval (human-in-the-loop gate #1)
- **FR-9** The task workspace has a **"Prepare Plan"** action.
- **FR-10** Tapping "Prepare Plan" triggers the cloud machine to start a **new AI planning session** (Claude Code in plan mode), passing in all task requirements. The agent **does not modify code** during planning.
- **FR-11** While planning runs, the task shows status **"Plan — In Progress."**
- **FR-12** When planning finishes, the task shows status **"Plan — Completed (Not Approved)"** and the **full plan is displayed in the Plan field** of the task.
- **FR-13** The user can **read the plan, edit/annotate it, and either Approve or send it back** for revision.
- **FR-14** The system persists the AI **session identifier** and all state needed to continue the same session later, so execution builds on the approved plan rather than starting cold.

### 6.5 Execution (development & testing)
- **FR-15** On **plan approval**, the cloud machine **resumes the same session** and begins implementation.
- **FR-16** The agent implements the change and then **runs unit tests**.
- **FR-17** The task status updates as it progresses: **Dev — In Progress → Dev — Done → Test — In Progress → Test — Passed** (or **Test — Failed**, which routes back into a fix loop — see §7.2).

### 6.6 Pull request & review-comment resolution (human-in-the-loop gate #2)
- **FR-18** When dev and tests are complete, the task surfaces a **proposed PR** (title, description, diff summary) for the user to review **before it is opened** (PR creation is an irreversible-ish public action — see §8).
- **FR-19** On user approval, the system **creates the PR** and stores the PR details on the task.
- **FR-20** The system **monitors the PR for review comments**. When reviewers leave comments, the task surfaces them.
- **FR-21** The user can instruct the agent to **address review comments**; the agent resumes the session, makes the fixes, pushes them, and marks each comment as addressed.
- **FR-22** This review loop repeats until the PR is approved.

### 6.7 Merge & deploy (human-in-the-loop gate #3)
- **FR-23** **Merging requires explicit user approval** in the app. The system never merges autonomously in v1.
- **FR-24** After merge, the system surfaces **deployment status** on the task (e.g., pipeline running / deployed / failed, plus environment).

### 6.8 Notifications
- **FR-25** LoopKeeper notifies the user (via its existing notification surface) when a task needs human action — plan ready for approval, PR ready to open, review comments arrived, deploy finished or failed.

---

## 7. The task stage model (state machine)

This is the backbone of the product. Every Jira task tracked in LoopKeeper has a **LoopKeeper stage** independent of (but synced with) its Jira status.

### 7.1 Stages and statuses

| # | Stage | Statuses it can show | Gate? |
|---|---|---|---|
| 1 | **Plan** | In Progress → Completed (Not Approved) → Approved | ✅ Human approval to leave this stage |
| 2 | **Dev** | In Progress → Done | — |
| 3 | **Test** | In Progress → Passed / Failed | — (failure loops back to Dev) |
| 4 | **PR** | Proposed → Created | ✅ Human approval to open PR |
| 5 | **Review** | Awaiting Review → Comments Received → Comments Addressed → Approved | — (loops until approved) |
| 6 | **Merge** | Ready → Merged | ✅ Human approval to merge |
| 7 | **Deploy** | Deploying → Deployed / Failed | — |

### 7.2 Loops (important)
- **Test failure loop:** `Test — Failed` → back to `Dev — In Progress` (agent fixes) → re-test. Capped by a max-iteration / budget limit (see Technical doc, "goal-driven loop").
- **Review loop:** `Comments Received` → `Comments Addressed` → reviewer re-reviews → either `Approved` or more comments. Repeats until approved or the user takes over.

### 7.3 Happy-path flow

```
Open task (requirements visible)
   │  user taps "Prepare Plan"
   ▼
Plan: In Progress ──► Plan: Completed (Not Approved)
   │  user reads / edits / approves
   ▼
Plan: Approved ──► Dev: In Progress ──► Dev: Done
   ▼
Test: In Progress ──► Test: Passed
   ▼
PR: Proposed ──(user approves)──► PR: Created
   ▼
Review: Awaiting ──► Comments Received ──(agent fixes)──► Comments Addressed ──► Review: Approved
   ▼
Merge: Ready ──(user approves)──► Merge: Merged
   ▼
Deploy: Deploying ──► Deploy: Deployed
```

---

## 8. Human-in-the-loop & safety principles

Because this system writes code, opens PRs, merges, and deploys on the user's behalf, the following are **product principles**, not optional features:

- **Three mandatory approval gates** in v1: **plan approval**, **PR creation**, and **merge**. Each is an explicit user tap; none happen automatically.
- **The agent never authors *and* merges its own change without a human in between.** (Industry-standard guardrail for unattended coding agents.)
- **Deploy** surfaces status; whether deploy auto-runs on merge depends on the team's existing CI/CD and is configurable (default: follow the repo's existing pipeline).
- **No secrets in the app.** Credentials are never typed into LoopKeeper screens; they live in a secrets manager and are injected on the cloud machine (see Technical doc §7).
- **Every action is auditable** — who/what triggered each transition, with timestamps and artifacts.
- **Budget and iteration caps** prevent runaway agent loops (cost and infinite-retry protection).

---

## 9. Non-functional requirements

| Area | Requirement |
|---|---|
| **Security** | OAuth-based integration auth; secrets in a managed vault; least-privilege tokens; isolated execution per task. |
| **Isolation** | Each task runs in its own isolated workspace so concurrent tasks never conflict (see Technical doc, git worktrees). |
| **Auditability** | Immutable stage-transition log per task. |
| **Cost control** | Per-task token/compute budget; concurrency caps; visible cost per task (nice-to-have v1.1). |
| **Observability** | Each agent session is traceable by session ID; failures escalate to the user rather than silently retrying forever. |
| **Reliability** | Long-running jobs survive transient failures (timeouts, model-overload fallback). |
| **Latency** | Plan generation and execution are async; the app reflects live status, the user is not blocked waiting. |
| **Privacy** | Source code and task data handled per the org's data-handling policy; clear boundaries on what leaves the cloud machine. |

---

## 10. Success metrics (proposed)

- **Activation:** % of connected users who run at least one task to "PR Created."
- **Throughput:** median tasks taken from "Prepare Plan" to "Merged" per active user per week.
- **Plan acceptance rate:** % of generated plans approved without major rewrite (proxy for plan quality).
- **Review-loop efficiency:** median number of agent fix iterations per PR before approval.
- **Human-effort saved:** self-reported / measured time from ticket-assigned to merged vs. baseline.
- **Safety:** zero unauthorized merges/deploys; 100% of gated actions preceded by an explicit user approval.

---

## 11. Phasing (suggested)

- **Phase 0 — Foundations:** Jira + GitHub integration, two-section Home, task workspace with stage history (read-only stages).
- **Phase 1 — Plan loop:** "Prepare Plan" → plan display → approve. (Highest-value, lowest-risk slice; no autonomous code changes.)
- **Phase 2 — Execute loop:** approved plan → dev + unit tests → propose PR → create PR on approval.
- **Phase 3 — Review loop:** monitor PR comments → agent resolves → re-review.
- **Phase 4 — Merge & deploy:** gated merge + deployment status surfacing.
- **Phase 5 — Hardening:** budgets, observability dashboards, cost-per-task, multi-repo polish.

---

## 12. Open questions / decisions needed

1. **Plan approval source of truth** — is the approved plan stored only in LoopKeeper, or also written back to the Jira ticket as a comment?
2. **Who can approve gates** — only the assignee, or can a tech lead approve on their behalf?
3. **Repo selection** — how does LoopKeeper know which repo/branch a Jira task maps to? (Convention, ticket field, or user picks at plan time?)
4. **Deploy ownership** — does LoopKeeper trigger deploys, or only observe the existing pipeline?
5. **Cost model** — per-seat, per-task, or usage-based, given the cloud-machine + agent compute cost (note: agent automation usage has its own billing meter — see Technical doc §8).
6. **Multi-tenancy** — one shared cloud machine pool for all users, or per-org isolation?
7. **Failure UX** — when the agent gets stuck or exceeds budget, exactly what does the user see and what are their recovery options?

---

_See the companion document `LoopKeeper-Engineering-Technical-Architecture.md` for the cloud-machine setup, Claude Code orchestration, worktree isolation, session lifecycle, the goal-driven loop, and the security model._
