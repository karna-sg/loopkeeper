import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { ServerConfig } from "./config.ts";
import type { AppDeps } from "./deps.ts";
import { registerHealth } from "./routes/health.ts";
import { registerLoops } from "./routes/loops.ts";
import { registerScan } from "./routes/scan.ts";
import { registerAuth } from "./routes/auth.ts";
import { registerDevices } from "./routes/devices.ts";
import { registerNudge } from "./routes/nudge.ts";
import { registerChannels } from "./routes/channels.ts";
import { registerEngineering } from "./routes/engineering.ts";
import { EngStore } from "../store/eng-store.ts";
import { NudgeService } from "../nudge/nudge-service.ts";
import { ApnsClient } from "../push/apns-client.ts";
import { LoopsStore } from "../store/loops-store.ts";
import { EncryptedFileVault, resolveMasterKey } from "../vault/token-vault.ts";
import type { TokenVault } from "../vault/token-vault.ts";
import { nodeHttp } from "../oauth/http.ts";
import type { HttpClient } from "../oauth/http.ts";
import { ScanService } from "../scan/scan-service.ts";
import { buildExtractionClient, buildDraftClient } from "../llm/factory.ts";
import type { MessageSource, TokenProvider } from "../sources/source.ts";
import { SlackSource, listSlackChannels } from "../sources/slack-source.ts";
import type { SlackChannelInfo } from "../sources/slack-source.ts";
import { GmailSource } from "../sources/gmail-source.ts";
import { refreshGoogleToken } from "../oauth/google-oauth.ts";
import { refreshJiraToken } from "../oauth/jira-oauth.ts";
import { CloudJiraClient, BasicJiraClient } from "../engineering/jira/jira-client.ts";
import type { JiraTokenProvider } from "../engineering/jira/jira-client.ts";
import { JiraSyncService } from "../engineering/jira/jira-sync.ts";
import { PrMonitor } from "../engineering/pr-monitor.ts";
import { DeployMonitor } from "../engineering/deploy-monitor.ts";
import { EngNotifier } from "../engineering/eng-notify.ts";
import { RestGithubClient } from "../engineering/adapters/rest-github.ts";
import type { UserIdentity } from "../domain/message.ts";
import { Scheduler } from "../scheduler/scheduler.ts";
import { daysBefore } from "../clock.ts";

/** Register all routes on an app built with injected dependencies (used by tests too). */
export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: false });

  // Bearer-token gate (when configured). Exempts the health probe and the browser OAuth flow.
  app.addHook("onRequest", async (req, reply) => {
    const token = deps.config.apiToken;
    if (!token) return;
    const path = (req.url.split("?")[0] ?? "");
    if (path === "/healthz" || path.startsWith("/auth/")) return;
    if (req.headers.authorization !== `Bearer ${token}`) {
      await reply.code(401).send({ error: "unauthorized" });
    }
  });

  registerHealth(app, deps);
  registerAuth(app, deps);
  registerLoops(app, deps);
  registerScan(app, deps);
  registerDevices(app, deps);
  registerNudge(app, deps);
  registerChannels(app, deps);
  registerEngineering(app, deps);
  return app;
}

function slackTokenProvider(vault: TokenVault, account: string): TokenProvider {
  return async () => {
    const token = vault.get("slack", account);
    if (!token) throw new Error(`no slack token for ${account}`);
    return token.accessToken;
  };
}

function googleTokenProvider(config: ServerConfig, vault: TokenVault, http: HttpClient, account: string): TokenProvider {
  return async () => {
    const token = vault.get("google", account);
    if (!token) throw new Error(`no google token for ${account}`);
    const expired = token.expiresAt !== undefined && new Date(token.expiresAt).getTime() <= Date.now();
    if (expired && token.refreshToken && config.google) {
      const refreshed = await refreshGoogleToken(http, {
        clientId: config.google.clientId,
        clientSecret: config.google.clientSecret,
        refreshToken: token.refreshToken,
      });
      vault.set("google", account, refreshed);
      return refreshed.accessToken;
    }
    return token.accessToken;
  };
}

/** Refresh-aware Jira token provider. Persists Atlassian's ROTATED refresh token every refresh. */
function jiraTokenProvider(config: ServerConfig, vault: TokenVault, http: HttpClient, account: string): JiraTokenProvider {
  return async () => {
    const token = vault.get("jira", account);
    if (!token) throw new Error(`no jira token for ${account}`);
    const expired = token.expiresAt !== undefined && new Date(token.expiresAt).getTime() <= Date.now();
    if (expired && token.refreshToken && config.jira) {
      const refreshed = await refreshJiraToken(http, {
        clientId: config.jira.clientId,
        clientSecret: config.jira.clientSecret,
        refreshToken: token.refreshToken,
        ...(token.meta ? { meta: token.meta } : {}),
      });
      vault.set("jira", account, refreshed);
      return refreshed.accessToken;
    }
    return token.accessToken;
  };
}

/** Build the Jira import service. Prefers the simple API-token (Basic) path, else OAuth. */
function buildProdJiraSync(config: ServerConfig, engStore: EngStore, vault: TokenVault, http: HttpClient): JiraSyncService {
  const mapping = { repo: config.github?.repo ?? "", defaultBranch: config.github?.baseBranch ?? "main" };

  // API-token path: no OAuth app / browser connect needed.
  if (config.jiraApiToken && config.jiraBaseUrl && config.jiraEmail) {
    const client = new BasicJiraClient(http, config.jiraBaseUrl, config.jiraEmail, config.jiraApiToken);
    return new JiraSyncService(client, engStore, { siteUrl: config.jiraBaseUrl, ...mapping });
  }

  // OAuth (3LO) path: requires /auth/jira to have stored a token.
  const entry = vault.list().find((v) => v.provider === "jira");
  if (!entry) {
    throw new Error("Jira not connected — set JIRA_BASE_URL/JIRA_EMAIL/JIRA_API_TOKEN, or visit /auth/jira");
  }
  const token = vault.get("jira", entry.account);
  const cloudId = token?.meta?.cloudId ?? entry.account;
  const siteUrl = token?.meta?.siteUrl ?? "";
  const client = new CloudJiraClient(http, jiraTokenProvider(config, vault, http, entry.account), cloudId);
  return new JiraSyncService(client, engStore, { siteUrl, ...mapping });
}

/** Construct the production scan service from the configured connectors. */
function buildProdScanService(
  config: ServerConfig,
  store: LoopsStore,
  vault: TokenVault,
  http: HttpClient,
  identity: UserIdentity,
): ScanService {
  const cfg = store.getSourceConfig();
  const sources: MessageSource[] = [];
  for (const { provider, account } of vault.list()) {
    if (provider === "slack") {
      sources.push(
        new SlackSource(http, slackTokenProvider(vault, account), identity, {
          channelIds: cfg.slackChannelIds,
          allMember: cfg.slackScope === "all_member",
        }),
      );
    }
    if (provider === "google") {
      sources.push(new GmailSource(http, googleTokenProvider(config, vault, http, account), identity, account, cfg.gmailQuery));
    }
  }
  if (sources.length === 0) throw new Error("no connectors — visit /auth/slack or /auth/google first");
  // buildExtractionClient throws if the selected provider's key is missing.
  return new ScanService(sources, buildExtractionClient(config), store, identity);
}

/** List the user's Slack channels (for the channel picker). Throws if Slack isn't connected. */
async function buildProdListChannels(vault: TokenVault, http: HttpClient): Promise<SlackChannelInfo[]> {
  const slack = vault.list().find((v) => v.provider === "slack");
  if (!slack) throw new Error("Slack not connected — visit /auth/slack first");
  const token = vault.get("slack", slack.account);
  if (!token) throw new Error("no slack token");
  return listSlackChannels(http, token.accessToken);
}

function buildProdNudgeService(config: ServerConfig, store: LoopsStore): NudgeService {
  if (!config.apns) throw new Error("APNs not configured (APNS_KEY_ID / APNS_TEAM_ID / APNS_BUNDLE_ID / APNS_KEY_P8)");
  return new NudgeService(store, new ApnsClient(config.apns));
}

/**
 * The autonomy layer: scan, nudge, and purge on intervals. Scan/nudge jobs throw when their
 * connectors aren't configured yet — the scheduler isolates and logs that, so the server keeps
 * running and the jobs start working the moment creds are added.
 */
function buildScheduler(config: ServerConfig, store: LoopsStore, engStore: EngStore, vault: TokenVault, http: HttpClient): Scheduler {
  const scheduler = new Scheduler((job, err) => {
    console.error(`[scheduler:${job}] skipped — ${err instanceof Error ? err.message : String(err)}`);
  });
  scheduler.add({
    name: "scan",
    intervalMs: config.scanEveryMin * 60_000,
    run: async () => {
      const now = new Date().toISOString();
      await buildProdScanService(config, store, vault, http, config.identity).run({
        sinceIso: daysBefore(now, 1), // last 1 day only
        nowIso: now,
        limitPerSource: 250, // lighter per-scan fetch
        includeQuoteExcerpt: config.includeQuoteExcerpt,
      });
    },
  });
  scheduler.add({
    name: "nudge",
    intervalMs: config.nudgeEveryMin * 60_000,
    run: async () => {
      if (!config.apns) return; // server push not configured — skip quietly (the app polls instead)
      await buildProdNudgeService(config, store).run({ nowIso: new Date().toISOString(), timezone: config.identity.timezone });
    },
  });
  scheduler.add({
    name: "purge",
    intervalMs: 24 * 60 * 60_000,
    run: async () => {
      store.purgeClosedOlderThan(daysBefore(new Date().toISOString(), config.ttlDays));
    },
  });
  // FR-2: import assigned Jira issues. Throws (and is isolated/logged) until Jira is connected.
  scheduler.add({
    name: "jira-sync",
    intervalMs: config.jiraSyncEveryMin * 60_000,
    run: async () => {
      await buildProdJiraSync(config, engStore, vault, http).run({ nowIso: new Date().toISOString() });
    },
  });
  // FR-20: poll open PRs for review comments / approval. Throws (isolated) until GitHub is configured.
  scheduler.add({
    name: "pr-monitor",
    intervalMs: config.prPollEveryMin * 60_000,
    run: async () => {
      if (!config.githubToken) throw new Error("GitHub not configured");
      await new PrMonitor(engStore, new RestGithubClient(config.githubToken), () => new Date().toISOString()).run();
    },
  });
  // FR-24: observe the GitHub Actions CD run for merged tasks → deploy:deployed/failed. Only in
  // github-actions deploy mode; throws (isolated) until GitHub is configured.
  scheduler.add({
    name: "deploy-status",
    intervalMs: config.prPollEveryMin * 60_000,
    run: async () => {
      if (config.deploy?.mode !== "github-actions") return; // ssh mode finalizes deploy in the worker
      if (!config.githubToken) throw new Error("GitHub not configured");
      await new DeployMonitor(engStore, new RestGithubClient(config.githubToken), () => new Date().toISOString(), config.eng.runTimeoutMs).run();
    },
  });
  // FR-25: push when a task needs a human (plan/PR/merge ready, comments, deploy failed, blocked).
  scheduler.add({
    name: "eng-notify",
    intervalMs: 60_000,
    run: async () => {
      if (!config.apns) return; // skip quietly when APNs isn't configured (no log flood)
      await new EngNotifier(engStore, new ApnsClient(config.apns), () => store.listDeviceTokens()).run();
    },
  });
  return scheduler;
}

/** Build the production app and its real dependencies from config. */
export function buildAppFromConfig(config: ServerConfig): { app: FastifyInstance; store: LoopsStore; scheduler: Scheduler } {
  const store = new LoopsStore(config.dbPath);
  const engStore = new EngStore(config.eng.dbPath);
  const vault = new EncryptedFileVault(config.vaultPath, resolveMasterKey(config.dataDir, config.masterKeyB64));
  const http: HttpClient = nodeHttp;
  const deps: AppDeps = {
    config,
    store,
    engStore,
    vault,
    http,
    identity: config.identity,
    buildScanService: () => buildProdScanService(config, store, vault, http, config.identity),
    buildNudgeService: () => buildProdNudgeService(config, store),
    buildDraftClient: () => buildDraftClient(config),
    listSlackChannels: () => buildProdListChannels(vault, http),
    buildJiraSync: () => buildProdJiraSync(config, engStore, vault, http),
    buildGithub: () => (config.githubToken ? new RestGithubClient(config.githubToken) : null),
    now: () => new Date().toISOString(),
  };
  return { app: buildApp(deps), store, scheduler: buildScheduler(config, store, engStore, vault, http) };
}
