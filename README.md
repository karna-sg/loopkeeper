# Loopkeeper — "Nothing slips."

Captures every commitment, request and deadline from **Slack + Gmail** into one list of
**open loops** — with the actual words said and the real due date — and nudges you before
any of them slips.

> Status: **Phase 0** — the backend extraction engine. iOS app + live OAuth ingestion come
> in Phase 1. See the plan at
> `~/.claude/plans/problem-statement-is-i-linear-eclipse.md`.

## Layout

```
loopkeeper/
  backend/   Node 22 / TypeScript ESM — extraction engine, gate, dedupe, Phase-0 runner
  ios/       (Phase 1) native SwiftUI app
```

## Phase 0 — extraction precision spike

The goal of Phase 0 is to **measure extraction precision on real-shaped data before any app
work**, because false-positive nudge fatigue is the category killer. Nothing here sends a
message or talks to a live channel; it runs over fixtures (and, optionally, a real Claude key).

```sh
pnpm install
pnpm -r build
pnpm -r test           # gate / due-date / redaction / dedupe / extractor (fake client)
pnpm --filter @loopkeeper/backend phase0          # run over fixtures with the fake client
ANTHROPIC_API_KEY=sk-ant-... \
  pnpm --filter @loopkeeper/backend phase0 --live # run over fixtures with the real model
```

Advance to Phase 1 only when firm-bucket precision clears ~80% on a labelled set.

## Conventions

Node 22+, TypeScript ESM, pnpm workspaces, vitest, oxlint, tsdown. `strict` + `verbatimModuleSyntax`;
no `any`, no `enum` (literal unions / `as const`), `node:` import prefixes, kebab-case modules.

## Privacy posture (honest)

Loopkeeper is **not** "local-first": message bodies are processed by the Claude API on each run,
and the backend stores per-user loops. It is **minimal-retention, redacted-metadata,
per-user-isolated** — only structured loop metadata is persisted, secret-shaped values are
redacted before any write, counterpart quotes are opt-in and off by default, and closed loops
are purged on a TTL.
