import type { HttpClient } from "./http.ts";
import type { StoredToken } from "../vault/token-vault.ts";

/** Gmail read-only — never a modify/send scope. `openid email` to identify the account. */
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "openid",
  "email",
] as const;

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export function buildGoogleAuthorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
  url.searchParams.set("access_type", "offline"); // get a refresh token
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", state);
  return url.toString();
}

/** Decode the `email` claim from a Google id_token without verifying (account label only). */
export function emailFromIdToken(idToken: string | undefined): string | undefined {
  if (!idToken) return undefined;
  const parts = idToken.split(".");
  if (parts.length < 2 || !parts[1]) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { email?: string };
    return payload.email;
  } catch {
    return undefined;
  }
}

interface GoogleTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
}

export interface GoogleTokenResult {
  account: string;
  token: StoredToken;
}

function expiryIso(expiresIn: number | undefined, nowMs: number): string | undefined {
  return expiresIn ? new Date(nowMs + expiresIn * 1000).toISOString() : undefined;
}

export async function exchangeGoogleCode(
  http: HttpClient,
  args: { clientId: string; clientSecret: string; code: string; redirectUri: string },
  nowMs: number = Date.now(),
): Promise<GoogleTokenResult> {
  const body = new URLSearchParams({
    client_id: args.clientId,
    client_secret: args.clientSecret,
    code: args.code,
    redirect_uri: args.redirectUri,
    grant_type: "authorization_code",
  }).toString();
  const res = await http.post(TOKEN_URL, {
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = (await res.json()) as GoogleTokenResponse;
  if (!data.access_token) throw new Error(`Google OAuth failed: ${data.error ?? "no access token"}`);
  const exp = expiryIso(data.expires_in, nowMs);
  return {
    account: emailFromIdToken(data.id_token) ?? "google",
    token: {
      accessToken: data.access_token,
      ...(data.refresh_token ? { refreshToken: data.refresh_token } : {}),
      ...(exp ? { expiresAt: exp } : {}),
      ...(data.scope ? { scope: data.scope } : {}),
    },
  };
}

/** Refresh an expired access token; returns the merged token (refresh token is reused). */
export async function refreshGoogleToken(
  http: HttpClient,
  args: { clientId: string; clientSecret: string; refreshToken: string },
  nowMs: number = Date.now(),
): Promise<StoredToken> {
  const body = new URLSearchParams({
    client_id: args.clientId,
    client_secret: args.clientSecret,
    refresh_token: args.refreshToken,
    grant_type: "refresh_token",
  }).toString();
  const res = await http.post(TOKEN_URL, {
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = (await res.json()) as GoogleTokenResponse;
  if (!data.access_token) throw new Error(`Google refresh failed: ${data.error ?? "no access token"}`);
  const exp = expiryIso(data.expires_in, nowMs);
  return {
    accessToken: data.access_token,
    refreshToken: args.refreshToken,
    ...(exp ? { expiresAt: exp } : {}),
    ...(data.scope ? { scope: data.scope } : {}),
  };
}
