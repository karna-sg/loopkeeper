/** Minimal HTTP seam so OAuth token exchange is testable without hitting the network. */
export interface HttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export interface HttpClient {
  post(url: string, opts: { headers?: Record<string, string>; body: string }): Promise<HttpResponse>;
  getJson(url: string, headers?: Record<string, string>): Promise<unknown>;
}

/** Max times to retry a rate-limited GET before giving up. */
const MAX_RETRIES = 4;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Honour Slack's Retry-After (seconds); fall back to a 1s base. */
function retryAfterMs(res: Response, attempt: number): number {
  const header = res.headers.get("retry-after");
  const secs = header === null ? Number.NaN : Number(header);
  const base = Number.isFinite(secs) ? Math.max(0, secs * 1000) : 1000;
  return base + attempt * 250; // a little jitter/backoff on top
}

/** Slack also signals throttling inside a 200 body: { ok:false, error:"ratelimited" }. */
function isRateLimitedBody(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const o = body as Record<string, unknown>;
  return o.ok === false && o.error === "ratelimited";
}

/** Production adapter over the global fetch, with Retry-After-aware backoff on 429 / ratelimited. */
export const nodeHttp: HttpClient = {
  async post(url, opts) {
    const res = await fetch(url, { method: "POST", headers: opts.headers, body: opts.body });
    return { ok: res.ok, status: res.status, json: () => res.json(), text: () => res.text() };
  },
  async getJson(url, headers) {
    for (let attempt = 0; ; attempt += 1) {
      const res = await fetch(url, { method: "GET", headers });
      if (res.status === 429 && attempt < MAX_RETRIES) {
        await sleep(retryAfterMs(res, attempt));
        continue;
      }
      if (!res.ok) throw new Error(`GET ${url} failed: ${res.status}`);
      const body = (await res.json()) as unknown;
      if (isRateLimitedBody(body) && attempt < MAX_RETRIES) {
        await sleep(retryAfterMs(res, attempt));
        continue;
      }
      return body;
    }
  },
};
