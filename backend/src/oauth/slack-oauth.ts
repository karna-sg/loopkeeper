import type { HttpClient } from "./http.ts";
import type { StoredToken } from "../vault/token-vault.ts";

/**
 * Slack OAuth v2 for a USER token (acts as the signed-in user, reads what they can see).
 * Minimal read scopes — no write/send scope is ever requested.
 */
export const SLACK_USER_SCOPES = [
  // read message bodies
  "channels:history",
  "groups:history",
  "im:history",
  "mpim:history",
  // list conversations (required by conversations.list — missing before)
  "channels:read",
  "groups:read",
  "im:read",
  "mpim:read",
  // search (for @mentions) + resolve names
  "search:read",
  "users:read",
] as const;

const AUTHORIZE_URL = "https://slack.com/oauth/v2/authorize";
const ACCESS_URL = "https://slack.com/api/oauth.v2.access";

export function buildSlackAuthorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("user_scope", SLACK_USER_SCOPES.join(","));
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

export interface SlackTokenResult {
  account: string;
  token: StoredToken;
}

/** Exchange an auth code for a user token. Throws on a Slack `ok:false` response. */
export async function exchangeSlackCode(
  http: HttpClient,
  args: { clientId: string; clientSecret: string; code: string; redirectUri: string },
): Promise<SlackTokenResult> {
  const body = new URLSearchParams({
    client_id: args.clientId,
    client_secret: args.clientSecret,
    code: args.code,
    redirect_uri: args.redirectUri,
  }).toString();
  const res = await http.post(ACCESS_URL, {
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = (await res.json()) as {
    ok?: boolean;
    error?: string;
    authed_user?: { id?: string; access_token?: string; scope?: string };
    team?: { id?: string; name?: string };
  };
  if (!data.ok || !data.authed_user?.access_token) {
    throw new Error(`Slack OAuth failed: ${data.error ?? "no user token"}`);
  }
  const account = data.team?.id ?? data.authed_user.id ?? "slack";
  const meta: Record<string, string> = {};
  if (data.authed_user.id) meta.userId = data.authed_user.id;
  if (data.team?.id) meta.teamId = data.team.id;
  if (data.team?.name) meta.teamName = data.team.name;
  return {
    account,
    token: {
      accessToken: data.authed_user.access_token,
      ...(data.authed_user.scope ? { scope: data.authed_user.scope } : {}),
      meta,
    },
  };
}
