import type { HttpClient } from "../oauth/http.ts";
import type { NormalizedMessage, UserIdentity } from "../domain/message.ts";
import type { MessageSource, TokenProvider } from "./source.ts";
import { redactSecrets } from "../redact.ts";

const API = "https://slack.com/api";
/** Max member channels read per scan. Generous so a real single-user workspace is never truncated. */
const MAX_CHANNELS = 200;
/** conversations.history/replies page size. Internal (non-distributed) apps stay Tier 3 (max 999). */
const PAGE_LIMIT = 200;
/** Safety valve so a single very busy channel can't run the scan forever. */
const MAX_HISTORY_PAGES = 10;
const MAX_REPLY_PAGES = 5;
/** Channel-list pagination (users.conversations). */
const MAX_CHANNEL_PAGES = 12;
/** search.messages pagination cap (@mention backstop). */
const MAX_SEARCH_PAGES = 5;
/** users.list pagination cap when resolving author names. */
const MAX_USER_PAGES = 20;
/** Hard ceiling on normalized messages per source per scan (runaway guard, NOT the old 30-cap). */
const HARD_CEILING = 2000;

export interface SlackChannelInfo {
  id: string;
  name: string;
  kind: "dm" | "group" | "channel";
  isMember: boolean;
}

interface RawChannel {
  id: string;
  name?: string;
  is_im?: boolean;
  is_mpim?: boolean;
  is_member?: boolean;
  user?: string;
}

/** A raw Slack message as returned by conversations.history / .replies. */
export interface SlackMessage {
  type?: string;
  subtype?: string;
  user?: string;
  bot_id?: string;
  username?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  reply_count?: number;
  edited?: { ts?: string };
  attachments?: ReadonlyArray<{ text?: string; fallback?: string; title?: string; pretext?: string }>;
  blocks?: unknown;
  files?: ReadonlyArray<{ title?: string; name?: string }>;
}

interface SlackPage {
  ok?: boolean;
  error?: string;
  messages?: SlackMessage[];
  has_more?: boolean;
  response_metadata?: { next_cursor?: string };
}

/**
 * Subtypes that carry no actionable content. Everything NOT in this set is kept — including
 * undefined (a normal message), bot_message (HR / Workflow Builder / Jira / GitHub posts),
 * thread_broadcast, file_share, file_comment, and me_message — so bot-authored action items
 * and shared-file asks are no longer silently dropped.
 */
const NOISE_SUBTYPES: ReadonlySet<string> = new Set([
  "channel_join",
  "channel_leave",
  "channel_topic",
  "channel_purpose",
  "channel_name",
  "channel_archive",
  "channel_unarchive",
  "group_join",
  "group_leave",
  "group_topic",
  "group_purpose",
  "group_name",
  "pinned_item",
  "unpinned_item",
  "bot_add",
  "bot_remove",
  "bot_disable",
  "bot_enable",
  "app_conversation_join",
  "reminder_add",
  "sh_room_created",
  "channel_posting_permissions",
]);

function kindOf(c: RawChannel): SlackChannelInfo["kind"] {
  if (c.is_im) return "dm";
  if (c.is_mpim) return "group";
  return "channel";
}

/** Human-readable origin shown in the UI. */
function channelLabelFor(c: RawChannel): string {
  if (c.is_im) return "DM";
  if (c.is_mpim) return "Group DM";
  return `#${c.name ?? c.id}`;
}

/** Walk Slack Block Kit nodes collecting any text/url leaf values (defensive against unknown shapes). */
function extractBlocksText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const o = node as Record<string, unknown>;
    if (typeof o.text === "string") out.push(o.text);
    else if (o.text && typeof o.text === "object") walk(o.text);
    if (typeof o.url === "string") out.push(o.url);
    for (const key of ["elements", "blocks"] as const) {
      const arr = o[key];
      if (Array.isArray(arr)) for (const child of arr) walk(child);
    }
  };
  for (const b of blocks) walk(b);
  return out.join(" ");
}

/**
 * Fold a Slack message's actionable text from every place it can live: top-level text,
 * legacy attachments, Block Kit blocks (for bot/Workflow posts whose text is empty), and
 * shared-file titles. De-duplicates identical fragments (text is often mirrored in fallback).
 */
export function slackMessageText(m: SlackMessage): string {
  const parts: string[] = [];
  if (m.text) parts.push(m.text);
  for (const a of m.attachments ?? []) {
    for (const v of [a.pretext, a.title, a.text, a.fallback]) if (v) parts.push(v);
  }
  // Block text mirrors top-level text for human messages; only mine it when there's bot/empty content.
  if (!m.text || m.subtype === "bot_message" || m.bot_id) {
    const blockText = extractBlocksText(m.blocks);
    if (blockText) parts.push(blockText);
  }
  for (const f of m.files ?? []) {
    for (const v of [f.title, f.name]) if (v) parts.push(v);
  }
  const seen = new Set<string>();
  return parts
    .map((p) => p.trim())
    .filter((p) => p && !seen.has(p) && (seen.add(p), true))
    .join("\n");
}

interface SlackUser {
  id?: string;
  name?: string;
  real_name?: string;
  profile?: { display_name?: string; real_name?: string };
}

function bestName(u: SlackUser | undefined): string | undefined {
  return u?.profile?.display_name || u?.profile?.real_name || u?.real_name || u?.name || undefined;
}

/**
 * One paginated users.list builds the whole id→name map for the scan (no per-author users.info,
 * no 60-id cap). Returns an empty map on failure so author ids simply stay unresolved.
 */
async function fetchWorkspaceUsers(http: HttpClient, token: string): Promise<Map<string, string>> {
  const auth = { authorization: `Bearer ${token}` };
  const map = new Map<string, string>();
  let cursor = "";
  for (let page = 0; page < MAX_USER_PAGES; page += 1) {
    const url = `${API}/users.list?limit=200` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
    let res: { ok?: boolean; members?: SlackUser[]; response_metadata?: { next_cursor?: string } };
    try {
      res = (await http.getJson(url, auth)) as typeof res;
    } catch {
      break;
    }
    if (res.ok === false) break;
    for (const u of res.members ?? []) {
      const name = bestName(u);
      if (u.id && name) map.set(u.id, name);
    }
    cursor = res.response_metadata?.next_cursor ?? "";
    if (!cursor) break;
  }
  return map;
}

/** Resolve a handful of leftover ids (e.g. shared-channel externals) via users.info. */
async function fetchUserNames(http: HttpClient, token: string, ids: readonly string[]): Promise<Map<string, string>> {
  const auth = { authorization: `Bearer ${token}` };
  const map = new Map<string, string>();
  for (const id of ids.slice(0, 60)) {
    try {
      const res = (await http.getJson(`${API}/users.info?user=${id}`, auth)) as { ok?: boolean; user?: SlackUser };
      const name = bestName(res.user);
      if (name) map.set(id, name);
    } catch {
      // skip unresolvable
    }
  }
  return map;
}

/** Make Slack's mention/link tokens human (and model) readable: <!channel> → @channel, etc. */
export function normalizeSlackText(text: string): string {
  return text
    .replace(/<!(channel|here|everyone)>/g, (_m, k: string) => `@${k}`)
    .replace(/<@[A-Z0-9]+(?:\|([^>]+))?>/g, (_m, name?: string) => `@${name ?? "user"}`)
    .replace(/<#[A-Z0-9]+(?:\|([^>]+))?>/g, (_m, name?: string) => `#${name ?? "channel"}`)
    .replace(/<(https?:[^|>]+)(?:\|([^>]+))?>/g, (_m, url: string, label?: string) => label ?? url)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

export interface NormalizeCtx {
  channelId: string;
  teamId: string;
  selfId: string;
  timezone: string;
  label?: string;
  permalink?: string;
  /** Workspace base URL from auth.test (e.g. https://acme.slack.com/) — lets us build the
   *  canonical /archives permalink, which the Slack iOS app opens natively (a Universal Link). */
  workspaceUrl?: string;
}

/**
 * The canonical Slack message permalink — the same `…/archives/<channel>/p<ts>` form Slack's own
 * chat.getPermalink returns and that the Slack app claims as a Universal Link (opens in-app).
 * Falls back to undefined when we don't know the workspace URL.
 */
export function slackArchiveUrl(workspaceUrl: string | undefined, channelId: string, ts: string, threadTs?: string): string | undefined {
  if (!workspaceUrl) return undefined;
  const base = workspaceUrl.endsWith("/") ? workspaceUrl : `${workspaceUrl}/`;
  const url = `${base}archives/${channelId}/p${ts.replace(".", "")}`;
  return threadTs && threadTs !== ts ? `${url}?thread_ts=${threadTs}&cid=${channelId}` : url;
}

/**
 * Convert a raw Slack message to the normalized shape, or null if it should be skipped
 * (noise subtype, non-message, or no usable text). Pure + exported for unit testing.
 */
export function normalizeSlackMessage(m: SlackMessage, ctx: NormalizeCtx): NormalizedMessage | null {
  if (!m.ts) return null;
  if (m.type && m.type !== "message") return null;
  if (m.subtype && NOISE_SUBTYPES.has(m.subtype)) return null;
  const raw = slackMessageText(m);
  if (!raw.trim()) return null;
  const author = m.user || m.username || "unknown";
  const permalink =
    ctx.permalink ??
    slackArchiveUrl(ctx.workspaceUrl, ctx.channelId, m.ts, m.thread_ts) ??
    `https://app.slack.com/client/${ctx.teamId}/${ctx.channelId}/${m.ts.replace(".", "")}`;
  const out: NormalizedMessage = {
    channel: "slack",
    tenant: ctx.teamId,
    sourceRef: `${ctx.channelId}:${m.ts}`,
    permalink,
    author,
    sourceLabel: ctx.label ?? "#channel",
    fromMe: ctx.selfId !== "" && m.user === ctx.selfId,
    timestamp: new Date(Number.parseFloat(m.ts) * 1000).toISOString(),
    sourceTimezone: ctx.timezone,
    text: redactSecrets(normalizeSlackText(raw)),
  };
  if (m.thread_ts) out.threadTs = m.thread_ts;
  if (m.edited?.ts) out.editedTs = m.edited.ts;
  return out;
}

/**
 * Every conversation the user is a member of (public + private channels, DMs, group DMs),
 * across all pages. Uses users.conversations (the user's own list) rather than the whole
 * workspace, so private + member channels aren't truncated.
 */
async function fetchUserConversations(http: HttpClient, token: string): Promise<RawChannel[]> {
  const auth = { authorization: `Bearer ${token}` };
  const all: RawChannel[] = [];
  let cursor = "";
  for (let page = 0; page < MAX_CHANNEL_PAGES; page += 1) {
    const url =
      `${API}/users.conversations?types=public_channel,private_channel,mpim,im&exclude_archived=true&limit=200` +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
    const res = (await http.getJson(url, auth)) as {
      ok?: boolean;
      error?: string;
      channels?: RawChannel[];
      response_metadata?: { next_cursor?: string };
    };
    if (res.ok === false) throw new Error(`Slack users.conversations: ${res.error ?? "failed"} (check token scopes)`);
    all.push(...(res.channels ?? []));
    cursor = res.response_metadata?.next_cursor ?? "";
    if (!cursor) break;
  }
  return all;
}

/** List the conversations the user is in (for the channel-picker UI). */
export async function listSlackChannels(http: HttpClient, token: string): Promise<SlackChannelInfo[]> {
  return (await fetchUserConversations(http, token)).map((c) => ({
    id: c.id,
    name: c.is_im ? `DM:${c.user ?? c.id}` : c.is_mpim ? "Group DM" : (c.name ?? c.id),
    kind: kindOf(c),
    isMember: true,
  }));
}

export interface SlackSourceOptions {
  /** Channel IDs to watch in addition to DMs + @mentions (used when allMember is false). */
  channelIds?: readonly string[];
  /** Read every channel the user is a member of (catches @channel/@here everywhere). */
  allMember?: boolean;
}

/**
 * Read-only Slack ingestion. Always reads DMs + group DMs (high-signal personal commitments) and
 * @mentions of the user; plus any explicitly configured channels (or every member channel when
 * allMember). Within the time window it paginates history fully and hydrates every thread via
 * conversations.replies, so threaded asks and messages beyond the first page are no longer lost.
 * Slack API errors surface as thrown errors instead of silently returning nothing.
 */
export class SlackSource implements MessageSource {
  readonly channel = "slack" as const;
  readonly #http: HttpClient;
  readonly #token: TokenProvider;
  readonly #identity: UserIdentity;
  readonly #channelIds: ReadonlySet<string>;
  readonly #allMember: boolean;
  #warnings: string[] = [];

  constructor(http: HttpClient, token: TokenProvider, identity: UserIdentity, options: SlackSourceOptions = {}) {
    this.#http = http;
    this.#token = token;
    this.#identity = identity;
    this.#channelIds = new Set(options.channelIds ?? []);
    this.#allMember = options.allMember ?? false;
  }

  /** Coverage warnings (search failure, channel truncation) from the most recent fetch. */
  drainWarnings(): string[] {
    const w = this.#warnings;
    this.#warnings = [];
    return w;
  }

  async fetchRecent({ sinceIso }: { sinceIso: string; limit: number }): Promise<NormalizedMessage[]> {
    this.#warnings = [];
    const token = await this.#token();
    const auth = { authorization: `Bearer ${token}` };
    const who = (await this.#http.getJson(`${API}/auth.test`, auth)) as { ok?: boolean; error?: string; user_id?: string; team_id?: string; url?: string };
    if (who.ok === false) throw new Error(`Slack auth.test: ${who.error ?? "failed"}`);
    const selfId = who.user_id ?? "";
    const teamId = who.team_id ?? "team";
    const workspaceUrl = who.url ?? "";
    const oldest = (new Date(sinceIso).getTime() / 1000).toFixed(6);

    // The user's own conversations (all member channels, public + private, paginated).
    const channels = await fetchUserConversations(this.#http, token);
    const labelOf = new Map(channels.map((c) => [c.id, channelLabelFor(c)]));

    // DMs + group DMs always; plus every member channel (all_member) or just the configured set.
    // DMs/group-DMs sorted first so they're processed before the runaway ceiling could bite.
    const eligible = channels
      .filter((c) => c.is_im || c.is_mpim || (this.#allMember ? true : this.#channelIds.has(c.id)))
      .sort((a, b) => Number(Boolean(b.is_im || b.is_mpim)) - Number(Boolean(a.is_im || a.is_mpim)));
    const targets = eligible.slice(0, MAX_CHANNELS);
    if (eligible.length > MAX_CHANNELS) {
      this.#warnings.push(`Slack: reading ${MAX_CHANNELS} of ${eligible.length} conversations this scan (cap); some channels not fully read.`);
    }

    const seen = new Set<string>();
    const out: NormalizedMessage[] = [];
    const ctxFor = (channelId: string, permalink?: string): NormalizeCtx => ({
      channelId,
      teamId,
      selfId,
      timezone: this.#identity.timezone,
      label: labelOf.get(channelId) ?? "#channel",
      workspaceUrl,
      ...(permalink ? { permalink } : {}),
    });
    const push = (channelId: string, m: SlackMessage, permalink?: string): void => {
      if (out.length >= HARD_CEILING) return;
      const norm = normalizeSlackMessage(m, ctxFor(channelId, permalink));
      if (!norm) return;
      if (seen.has(norm.sourceRef)) return;
      seen.add(norm.sourceRef);
      out.push(norm);
    };

    for (const ch of targets) {
      if (out.length >= HARD_CEILING) break;
      const threadRoots: string[] = [];

      // 1) Paginate channel history within the window.
      let cursor = "";
      for (let page = 0; page < MAX_HISTORY_PAGES; page += 1) {
        const url =
          `${API}/conversations.history?channel=${ch.id}&oldest=${oldest}&limit=${PAGE_LIMIT}` +
          (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
        const res = (await this.#http.getJson(url, auth)) as SlackPage;
        if (res.ok === false) break; // a single channel failing (e.g. not_in_channel) must not abort the scan
        for (const m of res.messages ?? []) {
          push(ch.id, m);
          // A thread root carries reply_count; remember it to hydrate replies below.
          if (m.ts && (m.reply_count ?? 0) > 0) threadRoots.push(m.ts);
        }
        cursor = res.response_metadata?.next_cursor ?? "";
        if (!cursor || res.has_more === false) break;
      }

      // 2) Hydrate every in-window thread — conversations.history returns ONLY thread roots, so
      //    reply-only asks/commitments are invisible without this.
      for (const rootTs of threadRoots) {
        if (out.length >= HARD_CEILING) break;
        let rCursor = "";
        for (let page = 0; page < MAX_REPLY_PAGES; page += 1) {
          const url =
            `${API}/conversations.replies?channel=${ch.id}&ts=${rootTs}&oldest=${oldest}&limit=${PAGE_LIMIT}` +
            (rCursor ? `&cursor=${encodeURIComponent(rCursor)}` : "");
          const res = (await this.#http.getJson(url, auth)) as SlackPage;
          if (res.ok === false) break;
          for (const m of res.messages ?? []) push(ch.id, m); // parent repeats here; `seen` collapses it
          rCursor = res.response_metadata?.next_cursor ?? "";
          if (!rCursor || res.has_more === false) break;
        }
      }
    }

    // @mentions anywhere — paginated backstop for asks in channels we don't read in full. On the
    // free plan this only reaches ~90 days; a failure is surfaced (not swallowed) so a dead net
    // can't masquerade as a clean scan.
    if (selfId && out.length < HARD_CEILING) {
      const query = encodeURIComponent(`<@${selfId}> after:${sinceIso.slice(0, 10)}`);
      for (let page = 1; page <= MAX_SEARCH_PAGES; page += 1) {
        let res: {
          ok?: boolean;
          error?: string;
          messages?: { matches?: Array<{ ts?: string; text?: string; user?: string; permalink?: string; channel?: { id?: string } }>; paging?: { pages?: number } };
        };
        try {
          res = (await this.#http.getJson(`${API}/search.messages?query=${query}&count=100&page=${page}`, auth)) as typeof res;
        } catch (err) {
          this.#warnings.push(`Slack @mention search failed: ${err instanceof Error ? err.message : String(err)}`);
          break;
        }
        if (res.ok === false) {
          this.#warnings.push(`Slack @mention search unavailable (${res.error ?? "error"}) — mention coverage degraded.`);
          break;
        }
        for (const match of res.messages?.matches ?? []) {
          if (match.channel?.id && match.ts) {
            push(match.channel.id, { type: "message", user: match.user, text: match.text, ts: match.ts }, match.permalink);
          }
        }
        if (page >= (res.messages?.paging?.pages ?? 1)) break;
      }
    }

    // Resolve author IDs → display names so counterparts read like "Priya", not "U123".
    // One paginated users.list covers everyone; users.info mops up any leftover externals.
    const ids = [...new Set(out.map((o) => o.author).filter((a) => a.startsWith("U") || a.startsWith("W")))];
    if (ids.length > 0) {
      const names = await fetchWorkspaceUsers(this.#http, token);
      const missing = ids.filter((id) => !names.has(id));
      if (missing.length > 0) for (const [id, name] of await fetchUserNames(this.#http, token, missing)) names.set(id, name);
      for (const message of out) message.author = names.get(message.author) ?? message.author;
    }

    return out;
  }
}
