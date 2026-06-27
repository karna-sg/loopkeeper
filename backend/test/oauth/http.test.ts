import { afterEach, describe, expect, it, vi } from "vitest";
import { nodeHttp } from "../../src/oauth/http.ts";

describe("nodeHttp.getJson rate-limit backoff", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("retries on a 429 (honouring Retry-After) then returns the body", async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return new Response("slow down", { status: 429, headers: { "retry-after": "0" } });
      return new Response(JSON.stringify({ ok: true, value: 42 }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await nodeHttp.getJson("https://slack.com/api/x")).toEqual({ ok: true, value: 42 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries on a 200 { ok:false, error:'ratelimited' } body then succeeds", async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      const body = calls === 1 ? { ok: false, error: "ratelimited" } : { ok: true, value: 7 };
      return new Response(JSON.stringify(body), { status: 200, headers: { "retry-after": "0" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await nodeHttp.getJson("https://slack.com/api/y")).toEqual({ ok: true, value: 7 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws on a non-retryable error status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 403 })),
    );
    await expect(nodeHttp.getJson("https://slack.com/api/z")).rejects.toThrow("403");
  });
});
