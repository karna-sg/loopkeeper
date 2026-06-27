/**
 * Secret-shaped value redaction. Applied to every field that gets persisted (summary,
 * counterpart, optional quote excerpt) and to message text before it is sent to the
 * model, per the secrets policy: never store or echo token/key/secret shapes.
 */

export const REDACTION_PLACEHOLDER = "[REDACTED:secret-shaped]";

/**
 * Ordered list of secret patterns. Vendor-specific prefixes first (precise), then
 * labelled-secret shapes (`api_key: <blob>`), then long high-entropy blobs. Order does
 * not affect correctness since each is replaced independently, but keeping the precise
 * ones first keeps the intent readable.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  // PEM / OpenSSH private key blocks (multi-line) — Phase 2 introduces deploy SSH + GitHub App keys.
  // Must run BEFORE the bare-blob rule so the whole block is replaced as one unit.
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g,
  // Anthropic
  /sk-ant-[A-Za-z0-9_-]{20,}/g,
  // OpenAI-style
  /sk-[A-Za-z0-9]{20,}/g,
  // Slack tokens
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  // GitHub tokens (classic gho_/ghp_/… and fine-grained github_pat_)
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  // GitLab PAT
  /glpat-[A-Za-z0-9_-]{20,}/g,
  // AWS access key id
  /AKIA[0-9A-Z]{16}/g,
  // Google API key
  /AIza[0-9A-Za-z_-]{20,}/g,
  // JWTs
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  // Bearer header
  /Bearer\s+[A-Za-z0-9._-]{20,}/gi,
  // Labelled secret: TOKEN/KEY/SECRET/PASSWORD/API_KEY = <20+ base64/hex chars>
  /\b(?:api[_-]?key|token|secret|password|passwd|bearer|access[_-]?key)\b\s*[:=]?\s*["']?[A-Za-z0-9+/_=-]{20,}["']?/gi,
  // Long high-entropy base64/hex blob (sha, key material), 40+ chars.
  /\b[A-Za-z0-9+/]{40,}={0,2}\b/g,
];

/** Replace any secret-shaped substring with the placeholder. Safe on empty/short input. */
export function redactSecrets(input: string): string {
  if (!input) return input;
  let out = input;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, REDACTION_PLACEHOLDER);
  }
  return out;
}

/** True if the input contains anything secret-shaped. */
export function containsSecret(input: string): boolean {
  return SECRET_PATTERNS.some((p) => {
    // RegExp with the global flag is stateful; test against a fresh copy.
    const fresh = new RegExp(p.source, p.flags.replace("g", ""));
    return fresh.test(input);
  });
}
