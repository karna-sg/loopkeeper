# Contributing to LoopKeeper

Thanks for your interest in contributing! LoopKeeper is a TypeScript (backend/worker) + SwiftUI (iOS) project. This guide covers how to get set up, the coding standards, and how to land a change.

## Getting started

```sh
git clone <repo-url> loopkeeper
cd loopkeeper
corepack enable          # activates the pinned pnpm@9.15.0
pnpm install
```

**Prerequisites:** Node `>=22` (22.6+ so dev scripts can run TypeScript directly), pnpm `9.15.0`, and a C/C++ toolchain for the `better-sqlite3` native module (`python3`, `make`, `g++` — prebuilds usually cover it). The engineering worker additionally needs `git`, the GitHub CLI (`gh`), and the Claude Code CLI; the iOS app needs macOS + Xcode + XcodeGen. See the [README prerequisites](./README.md#prerequisites) for versions.

## Development loop

Run everything from the repo root (scripts fan out with `pnpm -r`):

```sh
pnpm typecheck          # tsc --noEmit (strict)
pnpm lint               # oxlint
pnpm test               # vitest run
pnpm build              # tsdown → dist/*.mjs
```

Backend-specific (from `backend/` or via `pnpm --filter @loopkeeper/backend <script>`):

```sh
pnpm dev                # Fastify API in watch mode → http://127.0.0.1:8787
pnpm test:watch         # vitest watch
pnpm phase0             # run the open-loops extraction over fixtures (offline)
pnpm seed               # seed sample loops into loops.db
```

**Before you open a PR, make sure `pnpm typecheck && pnpm lint && pnpm test` all pass** — the same three checks run as the required CI gate (`.github/workflows/ci.yml`).

## Project structure

The backend is the only pnpm package. Two pipelines live side by side:

- **Open-loops** (product): `scan/`, `sources/`, `gate.ts`, `extractor.ts`, `llm/`, `store/loops-store.ts`, `nudge/`, `draft/`.
- **Engineering** (Phase 2): `engineering/` (orchestrator, `state-machine.ts`, `worker.ts`, `prompts.ts`, `adapters/`, `jira/`), `store/eng-store.ts`, and the `server/routes/engineering.ts` API.

See the [Technical Architecture](./LoopKeeper-Engineering-Technical-Architecture.md) for the engineering pipeline's design, and [`backend/README.md`](./backend/README.md) for package notes.

The engineering pipeline follows a **ports & adapters** pattern (`engineering/ports.ts`): the orchestrator and state machine are pure and unit-testable against fakes, and real I/O (Claude Code, git, GitHub, tests, deploy) lives behind typed adapters. New integrations should add an adapter behind a port, not call out directly from the orchestrator.

## Coding standards

**TypeScript** (enforced by `tsconfig.base.json` + oxlint):

- ESM only (`"type": "module"`); use `node:` import prefixes (`node:fs/promises`, not `fs`).
- `strict`, `noUncheckedIndexedAccess`, `isolatedModules`, `verbatimModuleSyntax` are on. Prefer `import type` for type-only imports.
- **No `any`** — use `unknown` and narrow. **No `enum`** — use `as const` objects or literal unions.
- Module filenames are **kebab-case** (PascalCase only for iOS/component files).
- Match the surrounding code's style, naming, and comment density.

**Tests:** vitest, placed under `backend/test/` mirroring `src/`. Add tests for new behavior; keep existing tests green — never delete or skip a test to make CI pass.

**iOS:** Swift 6 with strict concurrency. The Xcode project is generated from `ios/project.yml` (XcodeGen) and is **not** committed — don't commit `Loopkeeper.xcodeproj/` or `DerivedData/`.

## Commits & pull requests

- **Branch off `main`** — direct pushes and force-pushes to `main` are blocked by branch protection.
- Use **[Conventional Commits](https://www.conventionalcommits.org/)** (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:` …). If a change maps to a tracked issue, reference it (e.g. `LP-123`).
- Keep PRs focused and reviewable. Fill in what changed and why, and how you verified it.
- CI (`typecheck` + `lint` + `test`) must be green before merge.

## Security & secrets

- **Never commit secrets.** `.env*` files, databases, the token vault (`tokens.enc`), master keys, `*.p8`/`*.pem`, and deploy keys are gitignored — keep them that way. Only `*.env.example` templates (with blank values) belong in the repo.
- If you find a vulnerability, please follow **[SECURITY.md](./SECURITY.md)** rather than opening a public issue.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](./LICENSE).
