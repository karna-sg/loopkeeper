import { describe, expect, it } from "vitest";
import {
  DiffGuardError,
  combineDepFlags,
  depFlagFromReport,
  estimateAddedDeps,
  inspectDiff,
  stagedFilesFromDiff,
} from "../../src/engineering/diff-guard.ts";
import { REDACTION_PLACEHOLDER } from "../../src/redact.ts";

// Reuse the planted-secret fixtures from redact.test.ts so DiffGuard's secret core stays in lock-step
// with the redactor it delegates to.
const GH_PAT = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
const ANTHROPIC_KEY = "sk-ant-abcdefghijklmnopqrstuvwxyz0123456789";
const OPENSSH_KEY = [
  "-----BEGIN OPENSSH PRIVATE KEY-----",
  "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gt",
  "ZWQyNTUxOQAAACDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "-----END OPENSSH PRIVATE KEY-----",
].join("\n");

describe("inspectDiff: hard-fail on secret-shaped staged content", () => {
  it("blocks a staged GitHub PAT with a path + fixed reason", () => {
    const report = inspectDiff([{ path: "backend/src/config.ts", content: `const t = "${GH_PAT}";` }]);
    expect(report.blocked).toBe(true);
    expect(report.secretHits).toEqual([{ path: "backend/src/config.ts", reason: "secret-shaped staged content" }]);
    // The reason never contains the matched secret value.
    expect(report.secretHits[0]!.reason).not.toContain("ghp_");
  });

  it("blocks a staged Anthropic key and an OpenSSH private key block", () => {
    const anthropic = inspectDiff([{ path: "deploy/env.ts", content: `KEY=${ANTHROPIC_KEY}` }]);
    expect(anthropic.blocked).toBe(true);
    const ssh = inspectDiff([{ path: "scripts/deploy.sh", content: `echo "${OPENSSH_KEY}"` }]);
    expect(ssh.blocked).toBe(true);
  });

  it("does not scan files with no added content (e.g. a deletion-only change)", () => {
    const report = inspectDiff([{ path: "backend/src/ok.ts" }]);
    expect(report.blocked).toBe(false);
    expect(report.secretHits).toEqual([]);
  });
});

describe("inspectDiff: hard-fail on forbidden paths (content-independent)", () => {
  const forbidden: Array<[string, string]> = [
    [".env", "forbidden path (.env*)"],
    [".env.production", "forbidden path (.env*)"],
    ["backend/.env.local", "forbidden path (.env*)"],
    ["config/app.pem", "forbidden path (*.pem)"],
    ["id_rsa", "forbidden path (id_rsa*)"],
    ["secrets/id_rsa.pub", "forbidden path (id_rsa*)"],
    ["ops/vault/token.txt", "forbidden path (vault/)"],
    ["db-credentials.json", "forbidden path (*credentials*)"],
  ];

  for (const [path, reason] of forbidden) {
    it(`blocks ${path} even with no content`, () => {
      const report = inspectDiff([{ path }]);
      expect(report.blocked).toBe(true);
      expect(report.secretHits).toEqual([{ path, reason }]);
    });
  }

  it("a forbidden path takes precedence over the secret-content check", () => {
    const report = inspectDiff([{ path: ".env", content: `TOKEN=${GH_PAT}` }]);
    expect(report.secretHits).toEqual([{ path: ".env", reason: "forbidden path (.env*)" }]);
  });
});

describe("inspectDiff: soft dependency-change flag (never a hard block)", () => {
  it("flags a package.json dependency addition with an estimated count", () => {
    const content = [
      '  "dependencies": {',
      '    "left-pad": "^1.3.0",',
      '    "malicious-pkg": "1.0.0"',
      "  }",
    ].join("\n");
    const report = inspectDiff([{ path: "package.json", content }]);
    expect(report.blocked).toBe(false);
    expect(report.secretHits).toEqual([]);
    expect(report.depChanges).toEqual([{ path: "package.json", addedDeps: 2 }]);
  });

  it("does not count scripts/metadata entries as dependencies", () => {
    const content = ['  "name": "my-pkg",', '  "scripts": {', '    "build": "tsc"', "  }"].join("\n");
    expect(estimateAddedDeps("package.json", content)).toBe(0);
  });

  it("flags a pnpm-lock.yaml package addition (v9 name@version keys)", () => {
    const content = [
      "  left-pad@1.3.0:",
      "    resolution: {integrity: sha512-aaaaaaaaaaaaaaaaaaaa}",
      "  '@scope/malicious@2.0.0':",
      "    resolution: {integrity: sha512-bbbbbbbbbbbbbbbbbbbb}",
    ].join("\n");
    const report = inspectDiff([{ path: "pnpm-lock.yaml", content }]);
    expect(report.blocked).toBe(false);
    expect(report.depChanges).toEqual([{ path: "pnpm-lock.yaml", addedDeps: 2 }]);
  });

  it("treats a generic *.lock file as a dependency manifest", () => {
    const report = inspectDiff([{ path: "Cargo.lock", content: "  serde@1.0.0:" }]);
    expect(report.depChanges).toEqual([{ path: "Cargo.lock", addedDeps: 1 }]);
  });

  it("does not flag a manifest whose change added no dependency lines", () => {
    const report = inspectDiff([{ path: "package.json", content: '  "version": "1.2.0"' }]);
    expect(report.depChanges).toEqual([]);
  });
});

describe("inspectDiff: mixed + negative cases", () => {
  it("reports both a hard block and a soft dep flag in one pass", () => {
    const report = inspectDiff([
      { path: "src/leak.ts", content: `const k = "${GH_PAT}"` },
      { path: "package.json", content: '    "evil": "1.0.0"' },
    ]);
    expect(report.blocked).toBe(true);
    expect(report.secretHits).toHaveLength(1);
    expect(report.depChanges).toEqual([{ path: "package.json", addedDeps: 1 }]);
  });

  it("leaves ordinary code/prose untouched", () => {
    const report = inspectDiff([
      { path: "src/util.ts", content: "export const add = (a: number, b: number) => a + b;" },
      { path: "README.md", content: "Review the API key documentation page before Friday." },
    ]);
    expect(report.blocked).toBe(false);
    expect(report.secretHits).toEqual([]);
    expect(report.depChanges).toEqual([]);
  });

  it("classifies each file independently across a batch (guards containsSecret's global-flag state)", () => {
    const report = inspectDiff([
      { path: "a.ts", content: `x = "${GH_PAT}"` },
      { path: "b.ts", content: "just a normal sentence" },
      { path: "c.ts", content: `y = "${GH_PAT}"` },
    ]);
    expect(report.secretHits.map((h) => h.path)).toEqual(["a.ts", "c.ts"]);
  });
});

describe("stagedFilesFromDiff: parse `git diff --cached`", () => {
  const RAW = [
    "diff --git a/backend/src/config.ts b/backend/src/config.ts",
    "index 1111111..2222222 100644",
    "--- a/backend/src/config.ts",
    "+++ b/backend/src/config.ts",
    "@@ -1,2 +1,3 @@",
    " export const x = 1;",
    "-const old = 0;",
    `+const key = "${GH_PAT}";`,
    "diff --git a/deploy/key.pem b/deploy/key.pem",
    "new file mode 100644",
    "index 0000000..3333333",
    "Binary files /dev/null and b/deploy/key.pem differ",
    "diff --git a/README.md b/README.md",
    "index 4444444..5555555 100644",
    "--- a/README.md",
    "+++ b/README.md",
    "@@ -1 +1,2 @@",
    " # Title",
    "+Some added prose line.",
  ].join("\n");

  it("extracts added content per file and captures binary paths with no content", () => {
    const files = stagedFilesFromDiff(RAW);
    expect(files).toEqual([
      { path: "backend/src/config.ts", content: `const key = "${GH_PAT}";` },
      { path: "deploy/key.pem" },
      { path: "README.md", content: "Some added prose line." },
    ]);
  });

  it("feeds inspectDiff end-to-end: secret content + forbidden binary path both block", () => {
    const report = inspectDiff(stagedFilesFromDiff(RAW));
    expect(report.blocked).toBe(true);
    expect(report.secretHits).toEqual([
      { path: "backend/src/config.ts", reason: "secret-shaped staged content" },
      { path: "deploy/key.pem", reason: "forbidden path (*.pem)" },
    ]);
  });

  it("returns an empty list for an empty diff", () => {
    expect(stagedFilesFromDiff("")).toEqual([]);
  });
});

describe("depFlagFromReport / combineDepFlags", () => {
  it("derives a flag summing counts and de-duplicating paths", () => {
    const flag = depFlagFromReport({
      secretHits: [],
      blocked: false,
      depChanges: [
        { path: "package.json", addedDeps: 2 },
        { path: "pnpm-lock.yaml", addedDeps: 5 },
      ],
    });
    expect(flag).toEqual({ newDeps: 7, flaggedPaths: ["package.json", "pnpm-lock.yaml"] });
  });

  it("returns null when there are no dep changes", () => {
    expect(depFlagFromReport({ secretHits: [], depChanges: [], blocked: false })).toBeNull();
  });

  it("combines across commits (sum counts, union paths) and tolerates nulls", () => {
    const a = { newDeps: 2, flaggedPaths: ["package.json"] };
    const b = { newDeps: 3, flaggedPaths: ["package.json", "pnpm-lock.yaml"] };
    expect(combineDepFlags(a, b)).toEqual({ newDeps: 5, flaggedPaths: ["package.json", "pnpm-lock.yaml"] });
    expect(combineDepFlags(null, b)).toBe(b);
    expect(combineDepFlags(a, null)).toBe(a);
    expect(combineDepFlags(null, null)).toBeNull();
  });
});

describe("DiffGuardError", () => {
  it("carries the hits and a value-free, redacted message", () => {
    const report = inspectDiff([{ path: "src/leak.ts", content: `const k = "${GH_PAT}"` }]);
    const err = new DiffGuardError(report.secretHits);
    expect(err.name).toBe("DiffGuardError");
    expect(err.hits).toEqual(report.secretHits);
    expect(err.message).toContain("src/leak.ts");
    expect(err.message).toContain("secret-shaped staged content");
    expect(err.message).not.toContain("ghp_");
  });

  it("redacts any secret-shaped substring that reaches the message (defense-in-depth)", () => {
    // A contrived path carrying a secret shape must still be redacted before it appears in the message.
    const err = new DiffGuardError([{ path: `token/${GH_PAT}`, reason: "forbidden path (*credentials*)" }]);
    expect(err.message).toContain(REDACTION_PLACEHOLDER);
    expect(err.message).not.toContain("ghp_");
  });
});
