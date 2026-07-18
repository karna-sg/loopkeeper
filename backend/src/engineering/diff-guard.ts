/**
 * DiffGuard (LP-53) — a post-hoc pre-filter that inspects STAGED content before `git commit`, so a
 * hijacked-via-injection or simply sloppy agent cannot push a real key or a malicious dependency to a
 * branch the human merges from their phone with one tap.
 *
 * Two verdicts:
 *  - HARD FAIL (secret-shaped staged content, or a forbidden path like `.env*` / `*.pem`) → the caller
 *    throws {@link DiffGuardError} BEFORE committing; the worker escalates the task to `blocked`.
 *  - SOFT FLAG (a `package.json` / lockfile change) → the commit proceeds, but a {@link DiffGuardFlag}
 *    is persisted onto the task artifact so the merge gate surfaces "N new deps — confirm".
 *
 * This module is PURE (no I/O). `git-workspace.ts` reads `git diff --cached` and feeds it here; the
 * orchestrator persists the soft flag. Reuses `containsSecret` from `redact.ts` as the secret core.
 * The Path-allowlist policy story later folds its `.github/` / `oauth/` path checks into this module.
 */

import type { DiffGuardFlag } from "../domain/eng-task.ts";
import { containsSecret, redactSecrets } from "../redact.ts";

/** A blocking finding: secret-shaped staged content, or a forbidden path. */
export interface SecretHit {
  path: string;
  /** Fixed, value-free reason (never contains the matched secret) — safe to log/surface. */
  reason: string;
}

/** A soft dependency-manifest change with an estimated added-dependency count. */
export interface DepChange {
  path: string;
  addedDeps: number;
}

export interface DiffGuardReport {
  secretHits: SecretHit[];
  depChanges: DepChange[];
  /** True iff there is at least one hard finding — the caller must skip the commit. */
  blocked: boolean;
}

/** One staged file: `content` is the newly-ADDED text (`+` lines, prefix stripped); absent for binary/deletion-only. */
export interface StagedFile {
  path: string;
  content?: string;
}

/**
 * Forbidden-path rules (LP-53). Content-independent so a binary key with no diff text still hard-fails
 * on its path alone. Each entry is `[test, reason]`; the reason is fixed and value-free.
 */
const FORBIDDEN_PATHS: ReadonlyArray<readonly [RegExp, string]> = [
  [/(^|\/)\.env(\.|$)/i, "forbidden path (.env*)"],
  [/\.pem$/i, "forbidden path (*.pem)"],
  [/(^|\/)id_rsa/i, "forbidden path (id_rsa*)"],
  [/(^|\/)vault\//i, "forbidden path (vault/)"],
  [/credentials/i, "forbidden path (*credentials*)"],
];

/** First matching forbidden-path reason for `path`, or null. */
function forbiddenReason(path: string): string | null {
  for (const [re, reason] of FORBIDDEN_PATHS) {
    if (re.test(path)) return reason;
  }
  return null;
}

/** Whether a path is a dependency manifest we track: `package.json`, `pnpm-lock.yaml`, or `*.lock`. */
function isDepFile(path: string): boolean {
  const base = path.split("/").pop() ?? path;
  return base === "package.json" || base === "pnpm-lock.yaml" || base.endsWith(".lock");
}

// A `package.json` entry `"key": "value"` whose value looks like a version spec (range operator /
// digit / known scheme) — so ordinary `scripts`/metadata entries like `"build": "tsc"` don't inflate
// the estimate. Still an over-approximation for anything version-shaped.
const PKG_JSON_ENTRY = /^\s*"([^"]+)"\s*:\s*"(?:\^|~|>|<|=|\*|\d|workspace:|npm:|file:|link:|git|https?:|latest|next)/;
// Top-level metadata keys whose values are also version-shaped (a version bump is NOT a new dependency).
const PKG_META_KEYS: ReadonlySet<string> = new Set([
  "version", "name", "description", "main", "module", "types", "typings", "license", "author",
  "homepage", "repository", "bugs", "private", "type", "packageManager", "sideEffects", "engines",
  "os", "cpu", "funding", "keywords",
]);
// A lockfile package key: `react@18.2.0:` / `'@babel/code-frame@7.24.0':` (pnpm v9, yarn) or the pnpm
// v6 `/name/version:` shape. Version starts with a digit.
const LOCK_DEP_LINE = /@\d[\w.+-]*['"]?:\s*$/;
const LOCK_DEP_LINE_V6 = /^\s*\/.+\/\d[\w.+-]*:\s*$/;

/**
 * Estimate dependencies ADDED by a manifest/lockfile change from its added-line `content`. A soft
 * advisory: it over-approximates (counts every added dependency-shaped line, minus known metadata) so
 * it fails safe toward flagging for the human. Never used to block.
 */
export function estimateAddedDeps(path: string, content: string): number {
  const base = path.split("/").pop() ?? path;
  const lines = content.split("\n");
  if (base === "package.json") {
    let count = 0;
    for (const line of lines) {
      const key = PKG_JSON_ENTRY.exec(line)?.[1];
      if (key !== undefined && !PKG_META_KEYS.has(key)) count += 1;
    }
    return count;
  }
  // Lockfiles (pnpm-lock.yaml / *.lock): count added resolved-package keys.
  return lines.filter((l) => LOCK_DEP_LINE.test(l) || LOCK_DEP_LINE_V6.test(l)).length;
}

/**
 * Classify staged files. Pure. Forbidden-path rules run first (content-independent); otherwise
 * secret-shaped ADDED content hard-fails via `containsSecret`. Dependency manifests are additionally
 * soft-flagged. `blocked` is true iff any hard finding exists.
 */
export function inspectDiff(files: StagedFile[]): DiffGuardReport {
  const secretHits: SecretHit[] = [];
  const depChanges: DepChange[] = [];
  for (const { path, content } of files) {
    const forbidden = forbiddenReason(path);
    if (forbidden) {
      secretHits.push({ path, reason: forbidden });
    } else if (content !== undefined && containsSecret(content)) {
      secretHits.push({ path, reason: "secret-shaped staged content" });
    }
    if (content !== undefined && isDepFile(path)) {
      const addedDeps = estimateAddedDeps(path, content);
      if (addedDeps > 0) depChanges.push({ path, addedDeps });
    }
  }
  return { secretHits, depChanges, blocked: secretHits.length > 0 };
}

/**
 * Parse `git diff --cached` output into per-file staged content. Paths come from the `diff --git`
 * header (handles renames/binaries); `content` is the newly-added text (`+` lines, prefix stripped),
 * absent for binary/deletion-only files. Pure and self-contained.
 */
export function stagedFilesFromDiff(rawCachedDiff: string): StagedFile[] {
  const out: StagedFile[] = [];
  let path: string | null = null;
  let added: string[] = [];
  const flush = (): void => {
    if (path !== null) out.push(added.length > 0 ? { path, content: added.join("\n") } : { path });
    path = null;
    added = [];
  };
  for (const line of rawCachedDiff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flush();
      // `diff --git a/<src> b/<dst>` — take the destination (b/) path.
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      path = m?.[2] ?? null;
    } else if (line.startsWith("+++ ")) {
      // The unambiguous new-path line; overrides the header (skip deletions → /dev/null).
      const p = line.slice(4).trim();
      if (p !== "/dev/null") path = p.startsWith("b/") ? p.slice(2) : p;
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      added.push(line.slice(1));
    }
  }
  flush();
  return out;
}

/** Derive the soft dependency-change flag from a report, or null when no manifest changed. */
export function depFlagFromReport(report: DiffGuardReport): DiffGuardFlag | null {
  if (report.depChanges.length === 0) return null;
  return {
    newDeps: report.depChanges.reduce((sum, d) => sum + d.addedDeps, 0),
    flaggedPaths: [...new Set(report.depChanges.map((d) => d.path))],
  };
}

/**
 * Combine two soft flags (per-commit staged diffs are disjoint, so summing across the dev/test fix
 * loop yields a correct cumulative count). Either operand may be null.
 */
export function combineDepFlags(a: DiffGuardFlag | null, b: DiffGuardFlag | null): DiffGuardFlag | null {
  if (!a) return b;
  if (!b) return a;
  return { newDeps: a.newDeps + b.newDeps, flaggedPaths: [...new Set([...a.flaggedPaths, ...b.flaggedPaths])] };
}

/**
 * Thrown by `commitAndPush` on a hard DiffGuard hit (secret / forbidden path) BEFORE `git commit`.
 * The worker catch escalates the task to `blocked`. The message carries only paths + fixed reasons
 * (never the matched secret) and is redacted anyway for defense-in-depth.
 */
export class DiffGuardError extends Error {
  readonly hits: SecretHit[];
  constructor(hits: SecretHit[]) {
    const detail = hits.map((h) => `${h.path} (${h.reason})`).join("; ");
    super(redactSecrets(`DiffGuard blocked commit: ${hits.length} finding(s): ${detail}`));
    this.name = "DiffGuardError";
    this.hits = hits;
  }
}
