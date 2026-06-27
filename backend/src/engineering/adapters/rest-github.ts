import type { GithubPort, PrState, PullRequest } from "../ports.ts";
import type { ReviewComment } from "../../domain/eng-task.ts";

/**
 * GitHub REST adapter (the live impl of GithubPort; the port itself is the test seam). Uses the
 * repo-scoped fine-grained PAT. `findOpenPr`/`getPr` give reconcile-before-act for create/merge.
 */
export class RestGithubClient implements GithubPort {
  readonly #token: string;
  readonly #api = "https://api.github.com";

  constructor(token: string) {
    this.#token = token;
  }

  #headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.#token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "loopkeeper",
    };
  }

  async #get(path: string): Promise<unknown> {
    const res = await fetch(`${this.#api}${path}`, { headers: this.#headers() });
    if (!res.ok) throw new Error(`GitHub GET ${path} failed: ${res.status}`);
    return res.json();
  }

  async #send(method: "POST" | "PUT", path: string, body: unknown): Promise<{ status: number; json: unknown }> {
    const res = await fetch(`${this.#api}${path}`, { method, headers: { ...this.#headers(), "content-type": "application/json" }, body: JSON.stringify(body) });
    const json = (await res.json().catch(() => ({}))) as unknown;
    return { status: res.status, json };
  }

  async findOpenPr(repo: string, head: string): Promise<PullRequest | null> {
    const owner = repo.split("/")[0] ?? "";
    const list = (await this.#get(`/repos/${repo}/pulls?state=open&head=${owner}:${head}`)) as Array<{ number: number; html_url: string }>;
    const first = list[0];
    return first ? { number: first.number, url: first.html_url } : null;
  }

  async createPr(args: { repo: string; head: string; base: string; title: string; body: string }): Promise<PullRequest> {
    const { status, json } = await this.#send("POST", `/repos/${args.repo}/pulls`, { title: args.title, head: args.head, base: args.base, body: args.body });
    const data = json as { number?: number; html_url?: string; message?: string };
    if (!data.number || !data.html_url) throw new Error(`GitHub createPr failed (${status}): ${data.message ?? "unknown"}`);
    return { number: data.number, url: data.html_url };
  }

  async getPr(repo: string, num: number): Promise<PrState> {
    const pr = (await this.#get(`/repos/${repo}/pulls/${num}`)) as { number: number; html_url: string; merged: boolean };
    const reviews = (await this.#get(`/repos/${repo}/pulls/${num}/reviews`)) as Array<{ state: string }>;
    const rawComments = (await this.#get(`/repos/${repo}/pulls/${num}/comments`)) as Array<{ id: number; user?: { login?: string }; body?: string; path?: string; line?: number; created_at?: string }>;
    const comments: ReviewComment[] = rawComments.map((c) => ({
      externalId: String(c.id),
      author: c.user?.login ?? "reviewer",
      body: c.body ?? "",
      path: c.path ?? null,
      line: c.line ?? null,
      receivedTs: c.created_at ?? "",
      resolution: null,
      resolvedTs: null,
      resolvedCommitSha: null,
    }));
    return { number: pr.number, url: pr.html_url, reviewDecision: latestDecision(reviews), merged: pr.merged === true, comments };
  }

  async merge(repo: string, num: number, method: "merge" | "squash" | "rebase"): Promise<{ sha: string; merged: boolean }> {
    const { status, json } = await this.#send("PUT", `/repos/${repo}/pulls/${num}/merge`, { merge_method: method });
    const data = json as { merged?: boolean; sha?: string; message?: string };
    if (!data.merged || !data.sha) throw new Error(`GitHub merge failed (${status}): ${data.message ?? "unknown"}`);
    return { sha: data.sha, merged: true };
  }
}

function latestDecision(reviews: Array<{ state: string }>): PrState["reviewDecision"] {
  let decision: PrState["reviewDecision"] = null;
  for (const r of reviews) {
    if (r.state === "APPROVED") decision = "APPROVED";
    else if (r.state === "CHANGES_REQUESTED") decision = "CHANGES_REQUESTED";
  }
  return decision;
}
