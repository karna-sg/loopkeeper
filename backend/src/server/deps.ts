import type { ServerConfig } from "./config.ts";
import type { LoopsStore } from "../store/loops-store.ts";
import type { EngStore } from "../store/eng-store.ts";
import type { TokenVault } from "../vault/token-vault.ts";
import type { HttpClient } from "../oauth/http.ts";
import type { UserIdentity } from "../domain/message.ts";
import type { ScanService } from "../scan/scan-service.ts";
import type { NudgeService } from "../nudge/nudge-service.ts";
import type { DraftClient } from "../draft/draft-composer.ts";
import type { SlackChannelInfo } from "../sources/slack-source.ts";
import type { JiraSyncService } from "../engineering/jira/jira-sync.ts";
import type { GithubPort } from "../engineering/ports.ts";

/** Everything the routes need, injected so the app is testable with fakes. */
export interface AppDeps {
  config: ServerConfig;
  store: LoopsStore;
  /** The engineering orchestration store (separate eng.db). Always present (graceful when unused). */
  engStore: EngStore;
  vault: TokenVault;
  http: HttpClient;
  identity: UserIdentity;
  /** Built lazily because it needs current tokens; throws if extraction isn't configured. */
  buildScanService: () => ScanService;
  /** Built lazily; throws if APNs isn't configured. */
  buildNudgeService: () => NudgeService;
  /** Built lazily; throws if the model isn't configured. */
  buildDraftClient: () => DraftClient;
  /** List the user's Slack conversations for the channel picker; throws if Slack isn't connected. */
  listSlackChannels: () => Promise<SlackChannelInfo[]>;
  /** Built lazily; throws if Jira isn't connected. Imports assigned issues into eng.db (FR-2). */
  buildJiraSync: () => JiraSyncService;
  /** Returns a GitHub client when a token is configured, null otherwise. */
  buildGithub: () => GithubPort | null;
  /** Current instant (ISO). Injectable for deterministic tests. */
  now: () => string;
}
