import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import type { AppDeps } from "../deps.ts";
import { buildSlackAuthorizeUrl, exchangeSlackCode } from "../../oauth/slack-oauth.ts";
import { buildGoogleAuthorizeUrl, exchangeGoogleCode } from "../../oauth/google-oauth.ts";
import { buildJiraAuthorizeUrl, exchangeJiraCode } from "../../oauth/jira-oauth.ts";

/**
 * OAuth connect flows. Only read scopes are requested; tokens land in the encrypted vault.
 * CSRF state is kept in-memory (single-user, single-process is fine).
 */
export function registerAuth(app: FastifyInstance, deps: AppDeps): void {
  const states = new Set<string>();
  const redirectUri = (provider: string): string => `${deps.config.publicBaseUrl}/auth/${provider}/callback`;

  app.get("/auth/slack", async (_req, reply) => {
    if (!deps.config.slack) return reply.code(400).send({ error: "SLACK_CLIENT_ID / SLACK_CLIENT_SECRET not set" });
    const state = randomUUID();
    states.add(state);
    return reply.redirect(buildSlackAuthorizeUrl(deps.config.slack.clientId, redirectUri("slack"), state));
  });

  app.get("/auth/slack/callback", async (req, reply) => {
    const q = req.query as { code?: string; state?: string };
    if (!deps.config.slack) return reply.code(400).send({ error: "slack not configured" });
    if (!q.code || !q.state || !states.delete(q.state)) return reply.code(400).send({ error: "invalid state or code" });
    const { account, token } = await exchangeSlackCode(deps.http, {
      clientId: deps.config.slack.clientId,
      clientSecret: deps.config.slack.clientSecret,
      code: q.code,
      redirectUri: redirectUri("slack"),
    });
    deps.vault.set("slack", account, token);
    return { connected: "slack", account };
  });

  app.get("/auth/google", async (_req, reply) => {
    if (!deps.config.google) return reply.code(400).send({ error: "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set" });
    const state = randomUUID();
    states.add(state);
    return reply.redirect(buildGoogleAuthorizeUrl(deps.config.google.clientId, redirectUri("google"), state));
  });

  app.get("/auth/google/callback", async (req, reply) => {
    const q = req.query as { code?: string; state?: string };
    if (!deps.config.google) return reply.code(400).send({ error: "google not configured" });
    if (!q.code || !q.state || !states.delete(q.state)) return reply.code(400).send({ error: "invalid state or code" });
    const { account, token } = await exchangeGoogleCode(deps.http, {
      clientId: deps.config.google.clientId,
      clientSecret: deps.config.google.clientSecret,
      code: q.code,
      redirectUri: redirectUri("google"),
    });
    deps.vault.set("google", account, token);
    return { connected: "google", account };
  });

  app.get("/auth/jira", async (_req, reply) => {
    if (!deps.config.jira) return reply.code(400).send({ error: "JIRA_CLIENT_ID / JIRA_CLIENT_SECRET not set" });
    const state = randomUUID();
    states.add(state);
    return reply.redirect(buildJiraAuthorizeUrl(deps.config.jira.clientId, redirectUri("jira"), state));
  });

  app.get("/auth/jira/callback", async (req, reply) => {
    const q = req.query as { code?: string; state?: string };
    if (!deps.config.jira) return reply.code(400).send({ error: "jira not configured" });
    if (!q.code || !q.state || !states.delete(q.state)) return reply.code(400).send({ error: "invalid state or code" });
    const { account, token } = await exchangeJiraCode(deps.http, {
      clientId: deps.config.jira.clientId,
      clientSecret: deps.config.jira.clientSecret,
      code: q.code,
      redirectUri: redirectUri("jira"),
    });
    deps.vault.set("jira", account, token);
    return { connected: "jira", account };
  });
}
