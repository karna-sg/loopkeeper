# @loopkeeper/backend

The Loopkeeper extraction engine. Phase 0 is the **precision spike**: prove that we can pull
clean open loops (commitments / requests / action items) out of Slack + Gmail messages, with
the real due date, before building the iOS app.

## Pipeline

```
NormalizedMessage[]  →  gate()  →  GateCandidate[]  →  extractLoops(client)  →  OpenLoop[]
   (Slack/Gmail            (cheap, deterministic        (LLM via ExtractionClient,
    normalized)             keyword/regex; caps          then resolveDueDate + redact
                            tokens, high recall)          + dedupe)
```

- `src/gate.ts` — deterministic commitment/request/deadline/RSVP detector. High recall; the
  only hard filter is "no signal at all". Caps candidates per run (default 30) to bound cost.
- `src/extractor.ts` — `ExtractionClient` interface (injectable, so orchestration is testable
  without the network). `AnthropicExtractionClient` forces a structured tool call and caches
  the system prompt. `buildOpenLoops()` is a pure mapping: resolve date → hash → **redact** → row.
- `src/due-date.ts` — `resolveDueDate(phrase, nowIso, tz)`. The model never parses dates; this
  does, pinned to IST. Unresolvable phrases ("before the release", "asap") → `none` (never nudged).
- `src/dedupe.ts` — `commitmentHash` + `loopId`; dedupe key is
  `(channel, sourceRef, direction, commitmentHash)` so multiple commitments in one message survive.
- `src/redact.ts` — secret-shaped redaction applied to every persisted field and to message
  text before it is sent to the model.

## Commands

```sh
pnpm install
pnpm test            # vitest — gate / due-date / redaction / dedupe / extractor (51 tests)
pnpm run typecheck   # tsc --noEmit (strict, verbatimModuleSyntax, .ts imports)
pnpm run lint        # oxlint
pnpm run build       # tsdown -> dist/*.mjs (+ d.mts)

# Phase-0 report over fixtures (deterministic, offline stub client):
pnpm run phase0
# Same, but with the real model (needs a key):
ANTHROPIC_API_KEY=sk-ant-... node --experimental-strip-types src/phase0.ts --live
```

`LOOPKEEPER_NOW` overrides the reference instant (default `2026-06-25T04:00:00Z`) for
reproducible relative-date output. Drop a `test/fixtures/labels.json`
(`{ "<loopId>": "true" | "false" }`) to compute firm-bucket precision; **advance to Phase 1 at ~80%.**

## Phase 1 — the server

A single-user Fastify server wraps the engine with OAuth, an encrypted token vault, a SQLite
loops store, and a REST API the iOS app talks to. Read-only ingestion; **no send path exists.**

```sh
pnpm run dev      # node --watch, http://127.0.0.1:8787
pnpm run build && pnpm start
```

Layout: `server/` (app + config + routes), `store/loops-store.ts` (SQLite, WAL, dedupe UNIQUE +
TTL purge), `vault/token-vault.ts` (AES-256-GCM, single local key), `oauth/` (Slack user-token +
Google, read scopes only), `sources/` (Slack/Gmail adapters → `NormalizedMessage`), `scan/`
(ingest → gate → extract → upsert).

### Endpoints
| Method + path | Purpose |
|---|---|
| `GET /healthz` | status, loop count, connected accounts |
| `GET /auth/slack` · `GET /auth/google` | start OAuth (read-only scopes) |
| `GET /auth/{provider}/callback` | store token in the vault |
| `POST /scan?days=2` | ingest → gate → extract → upsert → flag closure candidates |
| `GET /brief` | overdue / today / upcoming / no-date / awaiting |
| `GET /loops?status=open,closed` | list (default: active, not snoozed) |
| `POST /loops/:id/done` · `/dismiss` · `/snooze` · `/label` | lifecycle + precision label |
| `GET /loops/:id/draft` | compose a suggested chaser (**never sent** — returned for review) |
| `POST /loops/:id/confirm-close` | confirm a `closed_candidate` → `closed` |
| `POST /devices` · `DELETE /devices/:token` | register/remove an APNs device token |
| `POST /nudge?days=1` | push self-reminders for at-risk owe-loops, mark them `nudged` |
| `DELETE /loops?counterpart=X` | erasure path (GDPR/DPDP) |

**Phase 2** adds: APNs push nudges (`push/`, `nudge/`), a draft-chaser composer
(`draft/` — suggests text, the backend never sends), and conservative same-channel closure
detection (`nudge/closure.ts` — a later "done/sent/kar diya" from you flags a `closed_candidate`,
never an auto-close).

### Env vars
| Var | Default | Notes |
|---|---|---|
| `PORT` / `HOST` | `8787` / `127.0.0.1` | |
| `LOOPKEEPER_PUBLIC_URL` | `http://host:port` | OAuth redirect base (tunnel URL for device) |
| `LOOPKEEPER_DATA_DIR` | `~/.loopkeeper` | holds `loops.db`, `tokens.enc`, `master.key` |
| `LOOPKEEPER_MASTER_KEY` | (auto-generated) | base64 32 bytes; else a local key file is created 0600 |
| `LOOPKEEPER_API_TOKEN` | (none) | if set, app routes require `Authorization: Bearer <token>` (set this before exposing the API to a device over LAN/tunnel; `/healthz` + `/auth/*` stay open) |
| `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` | — | from your Slack app |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | — | from Google Cloud OAuth (Testing mode) |
| `LLM_PROVIDER` | auto | `openai` or `anthropic`; auto-selects `openai` if `OPENAI_API_KEY` is set, else `anthropic` |
| `OPENAI_API_KEY` | — | required for `/scan` + `/loops/:id/draft` when provider is `openai` |
| `OPENAI_MODEL` | `gpt-4o-mini` | OpenAI model for extraction/drafts |
| `ANTHROPIC_API_KEY` | — | required for those routes when provider is `anthropic` |
| `APNS_KEY_ID` / `APNS_TEAM_ID` / `APNS_BUNDLE_ID` | — | from the Apple Developer portal |
| `APNS_KEY_P8` | — | PEM contents of `AuthKey_XXXX.p8` (`\n` escapes ok); required for `/nudge` |
| `APNS_ENV` | `sandbox` | `production` to hit prod APNs |
| `LOOPKEEPER_TZ` | `Asia/Kolkata` | due-date anchoring |
| `LOOPKEEPER_SCAN_EVERY_MIN` | `120` | auto-scan interval; `0` disables |
| `LOOPKEEPER_NUDGE_EVERY_MIN` | `60` | auto-nudge interval; `0` disables |
| `LOOPKEEPER_TTL_DAYS` | `30` | purge closed loops older than this (also the daily purge cutoff) |

### Autonomy (scheduler)
The server runs an in-process scheduler (`scheduler/`): **scan** every `SCAN_EVERY_MIN`, **nudge**
every `NUDGE_EVERY_MIN`, and **purge** once daily. Jobs whose connectors aren't configured yet are
logged-and-skipped (the server keeps running and they start working when creds are added). Run the
server under `launchd`/`pm2`/`tmux` so it stays alive; SIGINT/SIGTERM shut it down gracefully.

Multi-user later = swap SQLite for Postgres + per-user isolation; that's the only structural change.
