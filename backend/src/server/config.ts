import { homedir } from "node:os";
import { join } from "node:path";
import type { UserIdentity } from "../domain/message.ts";

/** Which LLM backs extraction + draft composition. */
export type LlmProvider = "anthropic" | "openai";

/** A registered OAuth app's credentials (one provider). Null when not yet configured. */
export interface OAuthAppConfig {
  clientId: string;
  clientSecret: string;
}

/** Token-based APNs credentials. Null until all four pieces are configured. */
export interface ApnsConfig {
  keyId: string;
  teamId: string;
  bundleId: string;
  p8Pem: string;
  production: boolean;
}

/** GitHub target for the engineering pipeline. Null until a repo is configured. */
export interface GithubConfig {
  /** "owner/name" of the one configured repo (dogfood: the LoopKeeper repo). */
  repo: string;
  baseBranch: string;
}

/** SSH redeploy target (the worker runs the redeploy after a gated merge). Null = disabled. */
export interface DeployConfig {
  /** `github-actions` (default) = GH Actions runs CD on push to main, LoopKeeper observes the run;
   *  `ssh` = legacy worker-triggered SSH redeploy. */
  mode: "github-actions" | "ssh";
  sshHost: string;
  sshUser: string;
  keyPath: string;
  remotePath: string;
  branch: string;
  /** Safety flag — deploy is a no-op until explicitly enabled. */
  enabled: boolean;
}

/** Engineering-orchestration knobs (shared by the api process and the worker). */
export interface EngConfig {
  enabled: boolean;
  /** Separate orchestration database (stage state, sessions, artifacts, jobs, budgets). */
  dbPath: string;
  /** Clone URL the worker uses (https form; auth injected at runtime, never stored here). */
  repoUrl: string | null;
  /** Where the worker keeps the mirror clone + per-task worktrees. */
  worktreeRoot: string;
  /** Path to the `claude` CLI on the worker. */
  claudeBin: string;
  /** Optional model override for the agent (else the CLI default). */
  claudeModel: string | null;
  /** Per-task caps (PRD §8/§9). */
  maxIterations: number;
  maxUsdCents: number;
  maxReviewRounds: number;
  /** Max spend (USD cents) for the two pre-review agent runs. Caps spend without blocking pr:proposed. */
  maxPreReviewUsdCents: number;
  /** Per-run wall-clock cap (ms). */
  runTimeoutMs: number;
  /** Max parallel worktrees/tasks. */
  maxConcurrent: number;
  /** Where stream-json transcripts are persisted (redacted at capture). */
  agentLogDir: string;
  /** Committer identity for worker commits (the container has no global git identity). */
  gitAuthorName: string;
  gitAuthorEmail: string;
}

export interface ServerConfig {
  port: number;
  host: string;
  /** Public base URL the OAuth providers redirect back to (e.g. an ngrok/tailscale URL). */
  publicBaseUrl: string;
  dataDir: string;
  dbPath: string;
  vaultPath: string;
  /** Base64 32-byte master key, or null to let the vault generate+persist one locally. */
  masterKeyB64: string | null;
  identity: UserIdentity;
  slack: OAuthAppConfig | null;
  google: OAuthAppConfig | null;
  llmProvider: LlmProvider;
  anthropicApiKey: string | null;
  /** Claude Code subscription auth (from `claude setup-token`) — preferred over the API key for the
   *  worker so the agent runs on the subscription, not metered API billing. Null = use `claude login`
   *  creds in ~/.claude, or fall back to anthropicApiKey. */
  claudeOauthToken: string | null;
  openaiApiKey: string | null;
  openaiModel: string;
  apns: ApnsConfig | null;
  /** Bearer token required on app-facing routes. Null = open (localhost dev only). */
  apiToken: string | null;
  /** Scheduler intervals (minutes); 0 disables that job. */
  scanEveryMin: number;
  nudgeEveryMin: number;
  /** Closed/dismissed loops older than this are purged. */
  ttlDays: number;
  /** Persist a short verbatim excerpt of the commitment (third-party data). Default off. */
  includeQuoteExcerpt: boolean;

  // --- Phase 2: engineering orchestration (all graceful-disable when unset) ---
  /** Jira OAuth (3LO) app credentials; null until configured (FR-1). */
  jira: OAuthAppConfig | null;
  /** Jira API-token (Basic auth) path — simplest for a single-user backend. All three required. */
  jiraBaseUrl: string | null;   // https://<site>.atlassian.net
  jiraEmail: string | null;
  jiraApiToken: string | null;  // secret; never echoed. From id.atlassian.com API tokens.
  /** The single user's Jira accountId — assignee-gate identity + GET /tasks filter (assignee-only). */
  selfAccountId: string | null;
  /** GitHub target repo; null until configured. */
  github: GithubConfig | null;
  /** Fine-grained PAT scoped to the one repo (worker clone/push, api PR REST). Never echoed. */
  githubToken: string | null;
  /** SSH redeploy target; null = no deploy. */
  deploy: DeployConfig | null;
  /** Prod URL the post-deploy verify stage smoke-checks (e.g. https://host/healthz). Null → manual confirm only. */
  deployVerifyUrl: string | null;
  /** Engineering knobs. */
  eng: EngConfig;
  /** Scheduler intervals (api side); 0 disables that job. */
  jiraSyncEveryMin: number;
  prPollEveryMin: number;
  /** Worker job-poll cadence (seconds). */
  workerPollEverySec: number;
}

function envApns(env: NodeJS.ProcessEnv): ApnsConfig | null {
  const keyId = env.APNS_KEY_ID;
  const teamId = env.APNS_TEAM_ID;
  const bundleId = env.APNS_BUNDLE_ID;
  // PEM contents directly, or with literal "\n" escaped (env-friendly).
  const p8Pem = env.APNS_KEY_P8?.replace(/\\n/g, "\n");
  if (!keyId || !teamId || !bundleId || !p8Pem) return null;
  return { keyId, teamId, bundleId, p8Pem, production: env.APNS_ENV === "production" };
}

function resolveProvider(env: NodeJS.ProcessEnv): LlmProvider {
  const explicit = env.LLM_PROVIDER;
  if (explicit === "openai" || explicit === "anthropic") return explicit;
  // Auto-select: if an OpenAI key is present and no provider was named, use OpenAI.
  return env.OPENAI_API_KEY ? "openai" : "anthropic";
}

function envOAuth(env: NodeJS.ProcessEnv, prefix: string): OAuthAppConfig | null {
  const clientId = env[`${prefix}_CLIENT_ID`];
  const clientSecret = env[`${prefix}_CLIENT_SECRET`];
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

function envGithub(env: NodeJS.ProcessEnv): GithubConfig | null {
  const repo = env.GITHUB_REPO;
  if (!repo) return null;
  return { repo, baseBranch: env.GITHUB_BASE_BRANCH ?? "main" };
}

function envDeploy(env: NodeJS.ProcessEnv): DeployConfig | null {
  const mode = env.DEPLOY_MODE === "ssh" ? "ssh" : "github-actions";
  const sshHost = env.DEPLOY_SSH_HOST;
  // ssh mode needs a host; github-actions mode owns the SSH inside the workflow, so nothing here.
  if (mode === "ssh" && !sshHost) return null;
  return {
    mode,
    sshHost: sshHost ?? "",
    sshUser: env.DEPLOY_SSH_USER ?? "deploy",
    keyPath: env.DEPLOY_SSH_KEY_PATH ?? "",
    remotePath: env.DEPLOY_REMOTE_PATH ?? "/opt/loopkeeper",
    branch: env.DEPLOY_BRANCH ?? env.GITHUB_BASE_BRANCH ?? "main",
    enabled: env.DEPLOY_ENABLED === "1",
  };
}

function envEng(env: NodeJS.ProcessEnv, dataDir: string): EngConfig {
  const numeric = (raw: string | undefined, fallback: number): number => {
    const n = Number(raw ?? "");
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    enabled: env.ENG_ENABLED !== "0",
    dbPath: env.ENG_DB_PATH ?? join(dataDir, "eng.db"),
    repoUrl: env.ENG_REPO_URL ?? null,
    worktreeRoot: env.ENG_WORKTREE_ROOT ?? join(dataDir, "eng", "worktrees"),
    claudeBin: env.ENG_CLAUDE_BIN ?? "claude",
    claudeModel: env.ENG_CLAUDE_MODEL ?? null,
    maxIterations: numeric(env.ENG_MAX_ITERATIONS, 6),
    maxUsdCents: numeric(env.ENG_TASK_BUDGET_USD_CENTS, 500),
    maxReviewRounds: numeric(env.ENG_MAX_REVIEW_ROUNDS, 5),
    maxPreReviewUsdCents: numeric(env.ENG_PRE_REVIEW_BUDGET_USD_CENTS, 50),
    runTimeoutMs: numeric(env.ENG_RUN_TIMEOUT_MS, 1_200_000),
    maxConcurrent: numeric(env.ENG_MAX_CONCURRENT, 1),
    agentLogDir: env.ENG_AGENT_LOG_DIR ?? join(dataDir, "eng", "agent-logs"),
    gitAuthorName: env.ENG_GIT_AUTHOR_NAME ?? "LoopKeeper Bot",
    gitAuthorEmail: env.ENG_GIT_AUTHOR_EMAIL ?? "bot@loopkeeper.local",
  };
}

/** Load configuration from the environment, applying single-user-local defaults. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const dataDir = env.LOOPKEEPER_DATA_DIR ?? join(homedir(), ".loopkeeper");
  const port = Number(env.PORT ?? "8787");
  const host = env.HOST ?? "127.0.0.1";
  return {
    port: Number.isFinite(port) ? port : 8787,
    host,
    publicBaseUrl: env.LOOPKEEPER_PUBLIC_URL ?? `http://${host}:${port}`,
    dataDir,
    dbPath: env.LOOPKEEPER_DB_PATH ?? join(dataDir, "loops.db"),
    vaultPath: env.LOOPKEEPER_VAULT_PATH ?? join(dataDir, "tokens.enc"),
    masterKeyB64: env.LOOPKEEPER_MASTER_KEY ?? null,
    identity: {
      displayName: env.LOOPKEEPER_USER_NAME ?? "Karna",
      aliases: (env.LOOPKEEPER_USER_ALIASES ?? "").split(",").map((s) => s.trim()).filter(Boolean),
      timezone: env.LOOPKEEPER_TZ ?? "Asia/Kolkata",
    },
    slack: envOAuth(env, "SLACK"),
    google: envOAuth(env, "GOOGLE"),
    llmProvider: resolveProvider(env),
    anthropicApiKey: env.ANTHROPIC_API_KEY ?? null,
    claudeOauthToken: env.CLAUDE_CODE_OAUTH_TOKEN ?? null,
    openaiApiKey: env.OPENAI_API_KEY ?? null,
    openaiModel: env.OPENAI_MODEL ?? "gpt-4o-mini",
    apns: envApns(env),
    apiToken: env.LOOPKEEPER_API_TOKEN ?? null,
    scanEveryMin: Number(env.LOOPKEEPER_SCAN_EVERY_MIN ?? "120"),
    nudgeEveryMin: Number(env.LOOPKEEPER_NUDGE_EVERY_MIN ?? "60"),
    ttlDays: Number(env.LOOPKEEPER_TTL_DAYS ?? "30"),
    includeQuoteExcerpt: env.LOOPKEEPER_INCLUDE_QUOTE === "1",
    jira: envOAuth(env, "JIRA"),
    jiraBaseUrl: env.JIRA_BASE_URL ?? null,
    jiraEmail: env.JIRA_EMAIL ?? null,
    jiraApiToken: env.JIRA_API_TOKEN ?? null,
    selfAccountId: env.LOOPKEEPER_JIRA_ACCOUNT_ID ?? null,
    github: envGithub(env),
    githubToken: env.GITHUB_TOKEN ?? null,
    deploy: envDeploy(env),
    deployVerifyUrl: env.DEPLOY_VERIFY_URL ?? null,
    eng: envEng(env, dataDir),
    jiraSyncEveryMin: Number(env.LOOPKEEPER_JIRA_SYNC_EVERY_MIN ?? "10"),
    prPollEveryMin: Number(env.LOOPKEEPER_PR_POLL_EVERY_MIN ?? "5"),
    workerPollEverySec: Number(env.LOOPKEEPER_WORKER_POLL_SEC ?? "15"),
  };
}
