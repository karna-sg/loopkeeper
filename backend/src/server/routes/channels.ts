import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../deps.ts";
import { GMAIL_PRESETS } from "../../domain/source-config.ts";

export function registerChannels(app: FastifyInstance, deps: AppDeps): void {
  // Current config + the Slack channels available to pick from (DMs/@mentions are always read).
  app.get("/channels", async (_req, reply) => {
    const config = deps.store.getSourceConfig();
    let slack: Array<{ id: string; name: string; kind: string; enabled: boolean }> = [];
    let slackError: string | null = null;
    try {
      const channels = await deps.listSlackChannels();
      const enabled = new Set(config.slackChannelIds);
      slack = channels
        .filter((c) => c.kind === "channel") // DMs/group-DMs are always read; only named channels are pickable
        .map((c) => ({ id: c.id, name: c.name, kind: c.kind, enabled: enabled.has(c.id) }));
    } catch (err) {
      slackError = err instanceof Error ? err.message : "could not list Slack channels";
    }
    void reply;
    return { slack, slackError, slackScope: config.slackScope, gmailQuery: config.gmailQuery, gmailPresets: GMAIL_PRESETS };
  });

  // Save Slack scope + channels + the Gmail importance query.
  app.put("/config", async (req) => {
    const body = (req.body ?? {}) as { slackScope?: unknown; slackChannelIds?: unknown; gmailQuery?: unknown };
    const patch: { slackScope?: "all_member" | "selected"; slackChannelIds?: string[]; gmailQuery?: string } = {};
    if (body.slackScope === "all_member" || body.slackScope === "selected") patch.slackScope = body.slackScope;
    if (Array.isArray(body.slackChannelIds)) {
      patch.slackChannelIds = body.slackChannelIds.filter((x): x is string => typeof x === "string");
    }
    if (typeof body.gmailQuery === "string" && body.gmailQuery.trim()) {
      patch.gmailQuery = body.gmailQuery.trim();
    }
    return deps.store.setSourceConfig(patch);
  });
}
