import type { HttpClient } from "../../oauth/http.ts";
import type { JiraIssue } from "./jira-mapper.ts";

/** Returns a fresh (refresh-aware) Jira access token. */
export type JiraTokenProvider = () => Promise<string>;

const FIELDS = "summary,description,status,labels,components,assignee";

/** Jira Cloud REST v3 client over the testable HttpClient seam. */
export interface JiraClient {
  /** Issues assigned to the authed user (FR-2). */
  searchAssigned(jql?: string): Promise<JiraIssue[]>;
  /** A single issue by numeric id or key — live detail fetch. Null if the body isn't a valid issue. */
  getIssue(idOrKey: string): Promise<JiraIssue | null>;
  /** The authed user's accountId (for the assignee gate identity). */
  currentUserAccountId(): Promise<string>;
  /** Post a comment to a Jira issue (LP-66). Body is plain text; client wraps it in minimal ADF. */
  addComment(issueIdOrKey: string, body: string): Promise<void>;
}

/** Shared parsing for the two auth variants below. */
function parseIssues(body: unknown): JiraIssue[] {
  if (typeof body !== "object" || body === null) return [];
  const issues = (body as { issues?: unknown }).issues;
  if (!Array.isArray(issues)) return [];
  return issues.filter((i): i is JiraIssue => {
    if (typeof i !== "object" || i === null) return false;
    const o = i as Record<string, unknown>;
    return typeof o.id === "string" && typeof o.key === "string" && typeof o.fields === "object" && o.fields !== null;
  });
}

/** Validate a single-issue GET body (the /issue/{id} endpoint returns the issue directly, not wrapped). */
function parseIssue(body: unknown): JiraIssue | null {
  if (typeof body !== "object" || body === null) return null;
  const o = body as Record<string, unknown>;
  if (typeof o.id === "string" && typeof o.key === "string" && typeof o.fields === "object" && o.fields !== null) {
    return body as JiraIssue;
  }
  return null;
}

/** `/search/jql` caps a page at 100; loop until `isLast`. MAX_PAGES bounds a pathological token loop. */
const PAGE_SIZE = 100;
const MAX_PAGES = 50;

function searchUrl(base: string, jql: string, pageToken?: string): string {
  const url = `${base}/search/jql?jql=${encodeURIComponent(jql)}&fields=${encodeURIComponent(FIELDS)}&maxResults=${PAGE_SIZE}`;
  return pageToken ? `${url}&nextPageToken=${encodeURIComponent(pageToken)}` : url;
}

/** The enhanced `/search/jql` cursor: a `nextPageToken` until `isLast` (the old `startAt` is gone). */
function nextPageToken(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const o = body as { nextPageToken?: unknown; isLast?: unknown };
  if (o.isLast === true) return null;
  return typeof o.nextPageToken === "string" && o.nextPageToken.length > 0 ? o.nextPageToken : null;
}

/**
 * Fetch ALL assigned issues across cursor pages. A single `/search/jql` request silently truncates a
 * large backlog (≈100/page), so without this loop a sync that returns >1 page would drop the oldest
 * tasks and make {@link JiraSyncService} reconcile prune them. Terminates on `isLast` / no token /
 * an empty or repeated page (guards the documented looping-token bug) and a hard MAX_PAGES cap.
 */
async function searchAllAssigned(
  http: HttpClient,
  base: string,
  jql: string,
  auth: () => Promise<Record<string, string>> | Record<string, string>,
): Promise<JiraIssue[]> {
  const out: JiraIssue[] = [];
  const seenTokens = new Set<string>();
  let token: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const body = await http.getJson(searchUrl(base, jql, token), await auth());
    const issues = parseIssues(body);
    out.push(...issues);
    const next = nextPageToken(body);
    if (!next || issues.length === 0 || seenTokens.has(next)) break;
    seenTokens.add(next);
    token = next;
  }
  return out;
}

function issueUrl(base: string, idOrKey: string): string {
  return `${base}/issue/${encodeURIComponent(idOrKey)}?fields=${encodeURIComponent(FIELDS)}`;
}

function commentUrl(base: string, idOrKey: string): string {
  return `${base}/issue/${encodeURIComponent(idOrKey)}/comment`;
}

/** Wrap plain text in the minimal Atlassian Document Format required by REST API v3 comments. */
function toAdf(body: string): string {
  return JSON.stringify({
    body: {
      type: "doc",
      version: 1,
      content: [{ type: "paragraph", content: [{ type: "text", text: body }] }],
    },
  });
}

const DEFAULT_JQL = "assignee = currentUser() ORDER BY updated DESC";

/** OAuth (3LO) variant — Bearer token against the api.atlassian.com cloudId gateway. */
export class CloudJiraClient implements JiraClient {
  readonly #http: HttpClient;
  readonly #token: JiraTokenProvider;
  readonly #base: string;

  constructor(http: HttpClient, token: JiraTokenProvider, cloudId: string) {
    this.#http = http;
    this.#token = token;
    this.#base = `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3`;
  }

  async #auth(): Promise<Record<string, string>> {
    return { authorization: `Bearer ${await this.#token()}`, accept: "application/json" };
  }

  async searchAssigned(jql = DEFAULT_JQL): Promise<JiraIssue[]> {
    return searchAllAssigned(this.#http, this.#base, jql, () => this.#auth());
  }

  async getIssue(idOrKey: string): Promise<JiraIssue | null> {
    return parseIssue(await this.#http.getJson(issueUrl(this.#base, idOrKey), await this.#auth()));
  }

  async currentUserAccountId(): Promise<string> {
    const body = (await this.#http.getJson(`${this.#base}/myself`, await this.#auth())) as { accountId?: string };
    return body.accountId ?? "";
  }

  async addComment(issueIdOrKey: string, body: string): Promise<void> {
    const res = await this.#http.post(commentUrl(this.#base, issueIdOrKey), {
      headers: { ...(await this.#auth()), "content-type": "application/json" },
      body: toAdf(body),
    });
    if (!res.ok) throw new Error(`Jira addComment failed: ${res.status}`);
  }
}

/** API-token variant — HTTP Basic (email:token) against the site directly. Simplest for one user. */
export class BasicJiraClient implements JiraClient {
  readonly #http: HttpClient;
  readonly #base: string;
  readonly #authHeader: string;

  constructor(http: HttpClient, baseUrl: string, email: string, apiToken: string) {
    this.#http = http;
    this.#base = `${baseUrl.replace(/\/$/, "")}/rest/api/3`;
    this.#authHeader = `Basic ${Buffer.from(`${email}:${apiToken}`).toString("base64")}`;
  }

  #auth(): Record<string, string> {
    return { authorization: this.#authHeader, accept: "application/json" };
  }

  async searchAssigned(jql = DEFAULT_JQL): Promise<JiraIssue[]> {
    return searchAllAssigned(this.#http, this.#base, jql, () => this.#auth());
  }

  async getIssue(idOrKey: string): Promise<JiraIssue | null> {
    return parseIssue(await this.#http.getJson(issueUrl(this.#base, idOrKey), this.#auth()));
  }

  async currentUserAccountId(): Promise<string> {
    const body = (await this.#http.getJson(`${this.#base}/myself`, this.#auth())) as { accountId?: string };
    return body.accountId ?? "";
  }

  async addComment(issueIdOrKey: string, body: string): Promise<void> {
    const res = await this.#http.post(commentUrl(this.#base, issueIdOrKey), {
      headers: { ...this.#auth(), "content-type": "application/json" },
      body: toAdf(body),
    });
    if (!res.ok) throw new Error(`Jira addComment failed: ${res.status}`);
  }
}
