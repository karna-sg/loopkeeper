import type { HttpClient } from "../../oauth/http.ts";
import type { JiraIssue } from "./jira-mapper.ts";

/** Returns a fresh (refresh-aware) Jira access token. */
export type JiraTokenProvider = () => Promise<string>;

const FIELDS = "summary,description,status,labels,components,assignee";

/** Read-only Jira Cloud REST v3 client over the testable HttpClient seam. */
export interface JiraClient {
  /** Issues assigned to the authed user (FR-2). */
  searchAssigned(jql?: string): Promise<JiraIssue[]>;
  /** The authed user's accountId (for the assignee gate identity). */
  currentUserAccountId(): Promise<string>;
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

function searchUrl(base: string, jql: string): string {
  return `${base}/search/jql?jql=${encodeURIComponent(jql)}&fields=${encodeURIComponent(FIELDS)}&maxResults=50`;
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
    return parseIssues(await this.#http.getJson(searchUrl(this.#base, jql), await this.#auth()));
  }

  async currentUserAccountId(): Promise<string> {
    const body = (await this.#http.getJson(`${this.#base}/myself`, await this.#auth())) as { accountId?: string };
    return body.accountId ?? "";
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
    return parseIssues(await this.#http.getJson(searchUrl(this.#base, jql), this.#auth()));
  }

  async currentUserAccountId(): Promise<string> {
    const body = (await this.#http.getJson(`${this.#base}/myself`, this.#auth())) as { accountId?: string };
    return body.accountId ?? "";
  }
}
