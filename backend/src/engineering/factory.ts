import { join } from "node:path";
import type { ServerConfig } from "../server/config.ts";
import type { EngStore } from "../store/eng-store.ts";
import { Orchestrator } from "./orchestrator.ts";
import { WorkerRunner } from "./worker.ts";
import { ClaudeAgentRunner } from "./adapters/claude-runner.ts";
import { GitWorkspace } from "./adapters/git-workspace.ts";
import { VitestTester, DEFAULT_VITEST_CONFIG } from "./adapters/vitest-tester.ts";
import { RestGithubClient } from "./adapters/rest-github.ts";
import { SshDeployer } from "./adapters/ssh-deployer.ts";
import type { GithubPort } from "./ports.ts";

/** The live GitHub adapter, or null when no token is configured (graceful). */
export function buildGithubPort(config: ServerConfig): GithubPort | null {
  return config.githubToken ? new RestGithubClient(config.githubToken) : null;
}

function repoUrl(config: ServerConfig): string {
  if (config.eng.repoUrl) return config.eng.repoUrl;
  if (config.github) return `https://github.com/${config.github.repo}.git`;
  throw new Error("no repo configured (ENG_REPO_URL or GITHUB_REPO)");
}

/** Build the orchestrator with the real adapters (worker process). */
export function buildOrchestrator(config: ServerConfig, engStore: EngStore, cancelRegistry?: Map<string, () => void>): Orchestrator {
  // Auth is handled by the Claude CLI: subscription OAuth token, API key, or a prior `claude login`
  // (~/.claude). We don't hard-require an env credential — `claude login` on the VM is valid.
  const agentRunner = new ClaudeAgentRunner({
    claudeBin: config.eng.claudeBin,
    model: config.eng.claudeModel,
    anthropicApiKey: config.anthropicApiKey,
    oauthToken: config.claudeOauthToken,
    timeoutMs: config.eng.runTimeoutMs,
    logDir: config.eng.agentLogDir,
    githubToken: config.githubToken,
  });
  const workspace = new GitWorkspace({
    repoUrl: repoUrl(config),
    mirrorDir: join(config.eng.worktreeRoot, "_mirror"),
    worktreeRoot: config.eng.worktreeRoot,
    defaultBranch: config.github?.baseBranch ?? "main",
    token: config.githubToken,
    authorName: config.eng.gitAuthorName,
    authorEmail: config.eng.gitAuthorEmail,
  });
  const tester = new VitestTester({ ...DEFAULT_VITEST_CONFIG, timeoutMs: config.eng.runTimeoutMs });
  // SSH deployer only exists in legacy ssh mode; github-actions mode observes the GH run instead.
  const deployer =
    config.deploy?.mode === "ssh"
      ? new SshDeployer({ host: config.deploy.sshHost, user: config.deploy.sshUser, keyPath: config.deploy.keyPath, timeoutMs: config.eng.runTimeoutMs })
      : null;
  return new Orchestrator({
    engStore,
    agentRunner,
    workspace,
    tester,
    github: buildGithubPort(config),
    deployer,
    deployEnabled: config.deploy?.enabled ?? false,
    deployMode: config.deploy?.mode ?? "github-actions",
    deployEnv: "prod",
    verifyUrl: config.deployVerifyUrl,
    maxPreReviewUsdCents: config.eng.maxPreReviewUsdCents,
    now: () => new Date().toISOString(),
    cancelRegistry,
  });
}

/** Build the worker runner (worker process entrypoint). */
export function buildWorker(config: ServerConfig, engStore: EngStore): WorkerRunner {
  const cancelRegistry = new Map<string, () => void>();
  return new WorkerRunner({
    engStore,
    orchestrator: buildOrchestrator(config, engStore, cancelRegistry),
    workerId: `worker-${process.pid}`,
    now: () => new Date().toISOString(),
    leaseMs: config.eng.runTimeoutMs * 2,
    cancelRegistry,
  });
}
