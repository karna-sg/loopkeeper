import { describe, expect, it } from "vitest";
import { buildSlackAuthorizeUrl, exchangeSlackCode } from "../../src/oauth/slack-oauth.ts";
import { buildGoogleAuthorizeUrl, emailFromIdToken, exchangeGoogleCode } from "../../src/oauth/google-oauth.ts";
import type { HttpClient, HttpResponse } from "../../src/oauth/http.ts";

function jsonHttp(payload: unknown): HttpClient {
  const res: HttpResponse = { ok: true, status: 200, json: async () => payload, text: async () => "" };
  return { post: async () => res, getJson: async () => payload };
}

describe("slack oauth", () => {
  it("builds an authorize URL with user_scope and state", () => {
    const url = new URL(buildSlackAuthorizeUrl("cid", "https://app/cb", "st8"));
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("state")).toBe("st8");
    expect(url.searchParams.get("user_scope")).toContain("search:read");
    expect(url.searchParams.get("scope")).toBeNull(); // user token, not bot
  });

  it("exchanges a code for a user token", async () => {
    const http = jsonHttp({ ok: true, authed_user: { id: "U1", access_token: "xoxp-tok", scope: "im:history" }, team: { id: "T1", name: "Lab" } });
    const { account, token } = await exchangeSlackCode(http, { clientId: "c", clientSecret: "s", code: "x", redirectUri: "r" });
    expect(account).toBe("T1");
    expect(token.accessToken).toBe("xoxp-tok");
  });

  it("throws on ok:false", async () => {
    const http = jsonHttp({ ok: false, error: "bad_code" });
    await expect(exchangeSlackCode(http, { clientId: "c", clientSecret: "s", code: "x", redirectUri: "r" })).rejects.toThrow(/bad_code/);
  });
});

describe("google oauth", () => {
  it("builds an authorize URL requesting offline access + gmail.readonly", () => {
    const url = new URL(buildGoogleAuthorizeUrl("cid", "https://app/cb", "st8"));
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("scope")).toContain("gmail.readonly");
  });

  it("decodes the email claim from an id_token", () => {
    const payload = Buffer.from(JSON.stringify({ email: "me@example.com" })).toString("base64url");
    expect(emailFromIdToken(`hdr.${payload}.sig`)).toBe("me@example.com");
    expect(emailFromIdToken(undefined)).toBeUndefined();
  });

  it("exchanges a code, capturing refresh token and expiry", async () => {
    const idToken = `h.${Buffer.from(JSON.stringify({ email: "me@example.com" })).toString("base64url")}.s`;
    const http = jsonHttp({ access_token: "AT", refresh_token: "RT", expires_in: 3600, scope: "gmail.readonly", id_token: idToken });
    const { account, token } = await exchangeGoogleCode(http, { clientId: "c", clientSecret: "s", code: "x", redirectUri: "r" }, 0);
    expect(account).toBe("me@example.com");
    expect(token.refreshToken).toBe("RT");
    expect(token.expiresAt).toBe(new Date(3600 * 1000).toISOString());
  });
});
