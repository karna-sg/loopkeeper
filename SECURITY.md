# Security Policy

LoopKeeper reads private messages (Slack/Gmail), holds OAuth tokens, and runs an autonomous coding agent with repository access. Security is a first-class concern. Thank you for helping keep it safe.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Use GitHub's **private vulnerability reporting**: go to the repository's **Security** tab → **Report a vulnerability**. This opens a private advisory visible only to the maintainers.

Please include:

- A description of the issue and its impact.
- Steps to reproduce (a minimal proof-of-concept if possible).
- Affected component (open-loops backend, engineering worker, iOS app, deployment).
- Any suggested remediation.

We aim to acknowledge reports within a few days and will keep you updated on the fix. Please give us reasonable time to remediate before any public disclosure.

## Supported versions

LoopKeeper is a single-user, actively-developed project; only the latest `main` is supported. Fixes land on `main` and ship via the standard deploy flow.

## Security model & posture

The design assumes an untrusted internet and a powerful-but-bounded agent. Key properties (details in the [Technical Architecture](./LoopKeeper-Engineering-Technical-Architecture.md#10-safety-model-summary)):

- **Secret redaction** — values matching secret shapes (`TOKEN`/`KEY`/`SECRET`/`PASSWORD`/`ghp_`/`xoxb-`/`sk-…`/private-key blocks) are redacted **before any database write, before any text is sent to a model, and in agent transcript logs**.
- **Encrypted token vault** — OAuth tokens are stored with AES-256-GCM (`tokens.enc`), keyed by a local master key that never leaves the host.
- **Read-only integrations** — Slack, Gmail, and Jira are accessed read-only; engineering state is never written back to Jira except an opt-in, DRAFT-first, human-approved comment.
- **API auth** — when `LOOPKEEPER_API_TOKEN` is set, all app routes require a bearer token. Note it **fails open** when unset, so it must be set before any non-localhost exposure.
- **Process isolation** — the internet-facing API and the code-executing worker are separate containers; the worker has **no inbound ports** and does not hold the deploy key.
- **Bounded agent blast radius** — Claude Code runs with a minimal, non-inherited environment (no prod secrets, no deploy key), a worktree-scoped working directory, a repo-scoped GitHub token, a pinned CLI version, per-run timeouts, and a detached process-group kill for cancellation.
- **Human gates** — the agent can never author *and* ship a change: plan, PR-open, merge, verify, and rollback each require an explicit human approval, enforced independently in both the state machine and the persistence layer.
- **Least-privilege deploy** — the CD SSH key is pinned to a forced command on the VM, so a leaked key can only redeploy merged `main` — nothing else.

## Handling secrets in contributions

Never commit real credentials. `.env*` files, databases, the token vault, master keys, `*.p8`/`*.pem`, and deploy keys are gitignored; only blank `*.env.example` templates belong in the repo. If you believe a secret was ever committed, report it privately via the process above so history can be scrubbed and the credential rotated.
