# LoopKeeper Engineering (Phase 2) — Setup Runbook

Everything in the code is built and the backend test suite is green (214 tests). This runbook is the
**configuration you do** to turn it on. Until configured, the feature stays dormant: `GET /tasks`
returns `503`, the iOS "My Jira Tasks" section is hidden, and the reminders app is unchanged.

Do the steps in order. Steps marked **[blocks worker]** must be done before the dev→deploy stages can run.

---

## 1. Put LoopKeeper on GitHub  **[blocks worker]**

This working copy isn't a git repo yet, and the worker clones LoopKeeper to operate on it.

```bash
cd /Users/karna/tools/loopkeeper
git init -b main
git add -A && git status        # confirm deploy/loopkeeper.env, .scratch/, *.pem, *.p8, node_modules, dist are NOT staged
git commit -m "Phase 0-2 baseline"
gh repo create <owner>/loopkeeper --private --source=. --remote=origin --push
```

Then **branch protection on `main`** (Settings → Branches): require PRs, require the `CI / verify`
status check, **block direct pushes and force-pushes**. This is a hard stop — even if the agent runs
`git push origin main`, the server rejects it (the gates remain the only path to main).

## 2. Fine-grained GitHub PAT  **[blocks worker]**

Create a **fine-grained PAT scoped to only the LoopKeeper repo**, permissions: **Contents: r/w**,
**Pull requests: r/w**. This goes in `deploy/loopkeeper.env` as `GITHUB_TOKEN` (worker only, never the app).

## 3. Jira OAuth app + your account id

- Atlassian Developer console → create an **OAuth 2.0 (3LO)** app. Scopes (read-only):
  `read:jira-work`, `read:jira-user`, `offline_access`. Callback URL: `https://<LK_HOST>/auth/jira/callback`.
- Put `JIRA_CLIENT_ID` / `JIRA_CLIENT_SECRET` in `deploy/loopkeeper.env`.
- After connecting (step 7), find your Jira `accountId` and set `LOOPKEEPER_JIRA_ACCOUNT_ID`
  (the assignee gate + `GET /tasks` filter; gates **fail closed** if it's unset).

## 4. Jira project + seed tickets  (dogfood)

Create a Jira project **key `LK`** ("LoopKeeper") and seed a few small, real LoopKeeper improvement
tickets assigned to you (each with a clear acceptance criterion so the agent can finish + verify via
`pnpm -r test`). I can create these for you via the connected Atlassian tools on your go-ahead —
they're Jira writes, so I'll confirm first. Set `JIRA_PROJECT_KEY=LK`.

## 5. Bigger VM  **[blocks worker]**

The current 1 GB Lightsail box will OOM running api + Caddy + a worker doing `pnpm install` + `vitest`
+ `claude`. **Upgrade to ≥4 GB** (snapshot → larger plan) and add a swapfile.

## 6. Secrets + deploy  **[blocks worker]**

On the VM, fill `deploy/loopkeeper.env` (see `deploy/loopkeeper.env.example`, `chmod 600`):
`ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, `GITHUB_REPO=<owner>/loopkeeper`, the Jira app creds,
`LOOPKEEPER_JIRA_ACCOUNT_ID`, and (later) the deploy SSH vars. Then:

```bash
cd deploy && docker compose up -d --build      # brings up loopkeeper (api) + worker + caddy
docker compose logs -f worker                  # "[worker] started — polling eng.db ..."
```

The worker shares `eng.db` with the api on the `lk_data` volume; the `lk_claude` volume persists
Claude Code sessions across restarts (required for FR-14 resume).

## 7. Connect Jira from the app

In the iOS app → Settings → **Engineering (Jira tasks) → Connect Jira** (opens
`https://<LK_HOST>/auth/jira` in Safari). After the callback, the next refresh imports your assigned
issues and "My Jira Tasks" appears on Home. (`POST /tasks/sync` forces an immediate re-import.)

## 8. Deploy stage (optional, do last)  **[gated]**

Deploy is OFF by default (`DEPLOY_ENABLED=0`). To enable the SSH redeploy after a gated merge:

1. Create a `deploy` user on the prod host (in the `docker` group), generate an SSH keypair.
2. Pin the key to a **forced command** in `~deploy/.ssh/authorized_keys`:
   `command="/opt/loopkeeper/ops/redeploy.sh",no-port-forwarding,no-pty ssh-ed25519 AAAA... deploy`
3. Put the private key at `deploy/deploy-key` (`chmod 600`), uncomment the worker's `deploy-key`
   mount in `deploy/docker-compose.yml`, and set `DEPLOY_*` vars + `DEPLOY_ENABLED=1`.
4. `ops/redeploy.sh` recreates **only** `loopkeeper` + `caddy` (never the worker), so the redeploy
   can't tear down its own process; it prints `REDEPLOY_OK <sha>` which the worker parses.

## 9. iOS build

The Xcode project is regenerated from `project.yml` (XcodeGen) and globs `ios/Sources/`, so the new
files are picked up automatically. Open in Xcode, build/run, point Settings → Backend URL at the VM.

---

## End-to-end smoke (first real task)

Open an `LK-*` task → **Prepare plan** → wait for "Plan ready" push → review/edit → **Approve plan**
→ watch Dev/Test run (force a failure once to see the fix-loop + budget escalation) → **Approve & open
PR** (Gate 2) → leave a review comment, then **Address comments** → on approval, **Approve merge**
(Gate 3) → Deploy (if enabled). Confirm in the timeline that every gate crossing shows
`gateApproved` by `user`, and that no secret-shaped text appears in `eng.db` or `agent-logs/`.

## Safety properties built in

- **Three mandatory gates** (plan, PR, merge) enforced in the pure state machine **and** the store —
  only `actor:"user"` + `gateApproved` can cross; agents/system/webhooks cannot (unit-tested per gate).
- **Budget/iteration caps** stop the dev/test loop and escalate to `blocked` (never infinite retry).
- **Reconcile-before-act** on PR create / merge; `max_attempts:1` on merge/deploy.
- **Secrets**: minimal agent env (no deploy key / prod token), repo-scoped PAT, branch protection,
  redaction of agent/git/ssh output before it's stored or shown.
