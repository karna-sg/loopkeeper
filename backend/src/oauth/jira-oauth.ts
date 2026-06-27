import type { HttpClient } from "./http.ts";
import type { StoredToken } from "../vault/token-vault.ts";

/**
 * Atlassian 3LO (OAuth 2.0 authorization code). READ-ONLY scopes — engineering state is owned by the
 * orchestration layer and never written back to Jira (decision #5), so no `write:jira-work`.
 * `offline_access` yields a refresh token; note Atlassian ROTATES it on every refresh, so the new
 * one MUST be persisted (unlike Google, whose refresh token is stable).
 */
export const JIRA_SCOPES = ["read:jira-work", "read:jira-user", "offline_access"] as const;

const AUTHORIZE_URL = "https://auth.atlassian.com/authorize";
const TOKEN_URL = "https://auth.atlassian.com/oauth/token";
const ACCESSIBLE_RESOURCES_URL = "https://api.atlassian.com/oauth/token/accessible-resources";

export function buildJiraAuthorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("audience", "api.atlassian.com");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("scope", JIRA_SCOPES.join(" "));
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("prompt", "consent");
  return url.toString();
}

interface JiraTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

interface AccessibleResource {
  id: string; // cloudId
  url: string; // site base URL, e.g. https://acme.atlassian.net
  name: string;
}

export interface JiraTokenResult {
  /** The vault account key for Jira = the cloudId (one site per connection in v1). */
  account: string;
  token: StoredToken;
}

function expiryIso(expiresIn: number | undefined, nowMs: number): string | undefined {
  return expiresIn ? new Date(nowMs + expiresIn * 1000).toISOString() : undefined;
}

/** Resolve the connected site (cloudId + base URL). Returns the first accessible resource. */
export async function fetchAccessibleResources(http: HttpClient, accessToken: string): Promise<AccessibleResource[]> {
  const body = (await http.getJson(ACCESSIBLE_RESOURCES_URL, {
    authorization: `Bearer ${accessToken}`,
    accept: "application/json",
  })) as unknown;
  if (!Array.isArray(body)) return [];
  return body.filter((r): r is AccessibleResource => {
    if (typeof r !== "object" || r === null) return false;
    const o = r as Record<string, unknown>;
    return typeof o.id === "string" && typeof o.url === "string";
  });
}

export async function exchangeJiraCode(
  http: HttpClient,
  args: { clientId: string; clientSecret: string; code: string; redirectUri: string },
  nowMs: number = Date.now(),
): Promise<JiraTokenResult> {
  const res = await http.post(TOKEN_URL, {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: args.clientId,
      client_secret: args.clientSecret,
      code: args.code,
      redirect_uri: args.redirectUri,
    }),
  });
  const data = (await res.json()) as JiraTokenResponse;
  if (!data.access_token) throw new Error(`Jira OAuth failed: ${data.error ?? "no access token"}`);

  const resources = await fetchAccessibleResources(http, data.access_token);
  const site = resources[0];
  if (!site) throw new Error("Jira OAuth: no accessible sites for this account");

  const exp = expiryIso(data.expires_in, nowMs);
  return {
    account: site.id,
    token: {
      accessToken: data.access_token,
      ...(data.refresh_token ? { refreshToken: data.refresh_token } : {}),
      ...(exp ? { expiresAt: exp } : {}),
      ...(data.scope ? { scope: data.scope } : {}),
      meta: { cloudId: site.id, siteUrl: site.url, siteName: site.name },
    },
  };
}

/**
 * Refresh an expired access token. Atlassian returns a NEW refresh token each time — this returns it
 * so the caller persists it (reusing the old one silently breaks the connection in ~90 days).
 */
export async function refreshJiraToken(
  http: HttpClient,
  args: { clientId: string; clientSecret: string; refreshToken: string; meta?: Record<string, string> },
  nowMs: number = Date.now(),
): Promise<StoredToken> {
  const res = await http.post(TOKEN_URL, {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: args.clientId,
      client_secret: args.clientSecret,
      refresh_token: args.refreshToken,
    }),
  });
  const data = (await res.json()) as JiraTokenResponse;
  if (!data.access_token) throw new Error(`Jira refresh failed: ${data.error ?? "no access token"}`);
  const exp = expiryIso(data.expires_in, nowMs);
  return {
    accessToken: data.access_token,
    // Persist the rotated refresh token; fall back to the old one only if the server omitted it.
    refreshToken: data.refresh_token ?? args.refreshToken,
    ...(exp ? { expiresAt: exp } : {}),
    ...(data.scope ? { scope: data.scope } : {}),
    ...(args.meta ? { meta: args.meta } : {}),
  };
}
