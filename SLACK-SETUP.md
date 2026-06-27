# Slack connector — setup & guarantees

How Loopkeeper reads Slack with **zero misses**, and the one install rule that keeps it fast.

## Install Loopkeeper as an INTERNAL Slack app (hard requirement)

Create the Slack app in **your own workspace** and **never enable public distribution / never submit it to the Slack Marketplace**.

Why this matters: since **2025-05-29** Slack throttles `conversations.history` and `conversations.replies` to **1 request/minute and 15 messages/request** for *non-Marketplace distributed* apps. **Internal customer-built apps are exempt** and keep **Tier 3 (50+/min, up to 1000 messages/request)**. Loopkeeper's full-history pagination + per-thread replies depend on Tier 3. As a single-user app this is free to satisfy — just leave the "Distribute App" / public distribution toggle **off**.

> If you ever flip public distribution on (without Marketplace approval), history/replies silently drop to 1/min + 15 objects and full coverage becomes infeasible. Don't.

## Scopes (user token)

Already requested by `/auth/slack` — **no re-authorization needed** for the current connector:

`channels:history`, `groups:history`, `im:history`, `mpim:history` (read messages) ·
`channels:read`, `groups:read`, `im:read`, `mpim:read` (list conversations) ·
`search:read` (@mention backstop) · `users:read` (resolve author names).

Deliberately **not** requested: `files:read`. Bot/Workflow text that arrives in the message payload (`attachments`/`blocks`) is captured; actual file *contents* and canvases are out of scope for now (would need `files:read` + a re-consent).

## What "zero misses" means here

The connector now, per scan:

- **Reads every member channel + DM + group DM** (not just the first 60), paginating `conversations.history` fully within the window — not just the newest 20.
- **Hydrates every in-window thread** via `conversations.replies`, so reply-only asks/commitments are captured (the single largest former miss class).
- **Keeps bot/Workflow/file-share messages** (subtype allowlist) and folds `attachments`/`blocks` text, so HR-bot, Jira/GitHub, and Workflow Builder action items are seen.
- **Sends every non-trivial DM + every @mention/broadcast to the model** regardless of keyword score (the deterministic gate only drops obvious noise now).
- **Re-extracts edited messages** (an edit that adds a deadline re-triggers extraction).
- **Catches up after downtime**: each scan extends its window back to the last successful scan, so no message ages out unscanned (clamped to 90 days).
- **Closes loops only within the same thread** (or the same DM) — a stray "done!" no longer mass-closes a channel.

Each message is still sent to the model **once, ever** (`seen_messages`), so cost stays bounded and re-scans never duplicate.

## Free-plan caveats (surfaced, not silent)

On a **Free** Slack workspace, `conversations.history` and `search.messages` only reach the **most recent ~90 days / 10k messages**. The @mention search backstop degrades accordingly. When search is unavailable or returns an error, the scan now **surfaces a warning** in `GET /scan/status` → `last.warnings[]` instead of silently reporting success. Initial backfill is likewise bounded to 90 days.

## Verifying a scan

```sh
curl -s -X POST -H "Authorization: Bearer <TOKEN>" "https://<host>/scan?days=7"
# wait, then:
curl -s -H "Authorization: Bearer <TOKEN>" https://<host>/scan/status | python3 -m json.tool
#   → last.fetched / gated / fresh / extracted / inserted, and last.warnings[]
curl -s -H "Authorization: Bearer <TOKEN>" https://<host>/brief | python3 -m json.tool
```
