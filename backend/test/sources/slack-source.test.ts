import { describe, expect, it } from "vitest";
import { SlackSource, slackMessageText, normalizeSlackMessage, slackArchiveUrl } from "../../src/sources/slack-source.ts";
import type { SlackMessage } from "../../src/sources/slack-source.ts";
import type { HttpClient } from "../../src/oauth/http.ts";
import type { UserIdentity } from "../../src/domain/message.ts";

const IDENTITY: UserIdentity = { displayName: "Karna", aliases: [], timezone: "Asia/Kolkata" };

interface Route {
  match: (url: string) => boolean;
  res: unknown;
}

/** A URL-routed fake Slack Web API, recording every call for assertions. */
class FakeSlack implements HttpClient {
  readonly calls: string[] = [];
  constructor(private readonly routes: Route[]) {}
  async post(): Promise<never> {
    throw new Error("no POST in these tests");
  }
  async getJson(url: string): Promise<unknown> {
    this.calls.push(url);
    for (const r of this.routes) if (r.match(url)) return r.res;
    return { ok: true };
  }
}

const has = (s: string) => (url: string) => url.includes(s);

function buildSlack(): FakeSlack {
  return new FakeSlack([
    { match: has("auth.test"), res: { ok: true, user_id: "USELF", team_id: "T1", url: "https://acme.slack.com/" } },
    {
      match: has("users.conversations"),
      res: {
        ok: true,
        channels: [
          { id: "C1", name: "general", is_member: true },
          { id: "D1", is_im: true, user: "U2" },
        ],
        response_metadata: { next_cursor: "" },
      },
    },
    // history page 2 (must be checked BEFORE page 1 since page-1 matcher is a prefix of both)
    {
      match: (u) => u.includes("conversations.history?channel=C1") && u.includes("cursor=PAGE2"),
      res: { ok: true, messages: [{ type: "message", user: "U2", text: "please update the device sheet", ts: "1750000050.000000" }], has_more: false },
    },
    // history page 1 for C1
    {
      match: (u) => u.includes("conversations.history?channel=C1") && !u.includes("cursor="),
      res: {
        ok: true,
        has_more: true,
        response_metadata: { next_cursor: "PAGE2" },
        messages: [
          { type: "message", user: "U2", text: "Q3 planning doc", ts: "1750000100.000000", reply_count: 1, thread_ts: "1750000100.000000" },
          { type: "message", user: "U3", text: "fyi the deck looks good", ts: "1750000200.000000" },
          { type: "message", subtype: "channel_join", user: "U9", text: "has joined the channel", ts: "1750000300.000000" },
          {
            type: "message",
            subtype: "bot_message",
            username: "WorkflowBot",
            text: "",
            ts: "1750000400.000000",
            blocks: [
              { type: "rich_text", elements: [{ type: "rich_text_section", elements: [{ type: "text", text: "Complete IT security training by July 1" }] }] },
            ],
          },
        ],
      },
    },
    // replies for the Q3 thread root
    {
      match: (u) => u.includes("conversations.replies?channel=C1") && u.includes("ts=1750000100.000000"),
      res: {
        ok: true,
        has_more: false,
        messages: [
          { type: "message", user: "U2", text: "Q3 planning doc", ts: "1750000100.000000", thread_ts: "1750000100.000000" },
          { type: "message", user: "U4", text: "can you own the capacity section by Wednesday?", ts: "1750000150.000000", thread_ts: "1750000100.000000" },
        ],
      },
    },
    // DM history
    {
      match: (u) => u.includes("conversations.history?channel=D1"),
      res: { ok: true, has_more: false, messages: [{ type: "message", user: "U2", text: "can you review the contract?", ts: "1750000500.000000" }] },
    },
    { match: has("search.messages"), res: { ok: true, messages: { matches: [] } } },
    { match: has("users.list"), res: { ok: true, members: [{ id: "U2", real_name: "Priya Shah" }, { id: "U4", real_name: "Ravi Menon" }] } },
    { match: has("users.info"), res: { ok: true, user: { real_name: "External Person" } } },
  ]);
}

describe("SlackSource.fetchRecent", () => {
  it("paginates history, hydrates threads, keeps useful subtypes, drops noise", async () => {
    const http = buildSlack();
    const source = new SlackSource(http, async () => "tok", IDENTITY, { allMember: true });
    const out = await source.fetchRecent({ sinceIso: "2025-06-15T00:00:00Z", limit: 1000 });
    const refs = out.map((m) => m.sourceRef);

    // history page 1 + page 2 (pagination followed the cursor)
    expect(refs).toContain("C1:1750000100.000000"); // thread root
    expect(refs).toContain("C1:1750000200.000000"); // normal page-1 msg
    expect(refs).toContain("C1:1750000050.000000"); // page-2 msg (only seen if cursor followed)

    // thread reply hydrated via conversations.replies — the reply-only ask
    const reply = out.find((m) => m.sourceRef === "C1:1750000150.000000");
    expect(reply?.text).toContain("capacity section by Wednesday");
    expect(reply?.threadTs).toBe("1750000100.000000");
    expect(http.calls.some((u) => u.includes("conversations.replies?channel=C1"))).toBe(true);

    // bot_message kept, text mined from blocks
    const bot = out.find((m) => m.sourceRef === "C1:1750000400.000000");
    expect(bot?.text).toContain("Complete IT security training by July 1");

    // channel_join noise dropped
    expect(refs).not.toContain("C1:1750000300.000000");

    // DM captured + labelled
    const dm = out.find((m) => m.sourceRef === "D1:1750000500.000000");
    expect(dm?.sourceLabel).toBe("DM");

    // no global 30-cap collapse: every non-noise message above is present
    expect(out.length).toBeGreaterThanOrEqual(6);

    // author ids resolved to display names via users.list (one paginated call, no 60-cap)
    expect(reply?.author).toBe("Ravi Menon"); // U4
    expect(dm?.author).toBe("Priya Shah"); // U2
    expect(http.calls.some((u) => u.includes("users.list"))).toBe(true);

    // permalinks use the canonical /archives Universal Link (opens the Slack app), not /client
    expect(dm?.permalink).toBe("https://acme.slack.com/archives/D1/p1750000500000000");
    expect(reply?.permalink).toBe("https://acme.slack.com/archives/C1/p1750000150000000?thread_ts=1750000100.000000&cid=C1");
  });

  it("surfaces a warning (instead of silence) when @mention search is unavailable", async () => {
    const http = new FakeSlack([
      { match: has("auth.test"), res: { ok: true, user_id: "USELF", team_id: "T1", url: "https://acme.slack.com/" } },
      { match: has("users.conversations"), res: { ok: true, channels: [{ id: "D1", is_im: true, user: "U2" }] } },
      {
        match: (u) => u.includes("conversations.history?channel=D1"),
        res: { ok: true, has_more: false, messages: [{ type: "message", user: "U2", text: "can you sign the form?", ts: "1750000500.000000" }] },
      },
      { match: has("search.messages"), res: { ok: false, error: "not_allowed_token_type" } },
      { match: has("users.list"), res: { ok: true, members: [{ id: "U2", real_name: "Bob" }] } },
    ]);
    const source = new SlackSource(http, async () => "tok", IDENTITY, { allMember: true });
    const out = await source.fetchRecent({ sinceIso: "2025-06-15T00:00:00Z", limit: 1000 });

    expect(out.find((m) => m.sourceRef === "D1:1750000500.000000")?.author).toBe("Bob");
    const warnings = source.drainWarnings();
    expect(warnings.some((w) => /search/i.test(w))).toBe(true);
    expect(source.drainWarnings()).toEqual([]); // drained
  });
});

describe("slackMessageText", () => {
  it("folds attachments and de-dupes mirrored fragments", () => {
    const m: SlackMessage = { text: "see the doc", attachments: [{ text: "review by Friday", fallback: "review by Friday" }] };
    expect(slackMessageText(m)).toBe("see the doc\nreview by Friday");
  });

  it("mines Block Kit text for a bot message with empty top-level text", () => {
    const m: SlackMessage = {
      subtype: "bot_message",
      text: "",
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "PROJ-123 assigned to you — due 2026-07-02" } }],
    };
    expect(slackMessageText(m)).toContain("PROJ-123 assigned to you");
  });
});

describe("slackArchiveUrl", () => {
  it("builds the canonical /archives permalink (handles trailing slash)", () => {
    expect(slackArchiveUrl("https://acme.slack.com/", "C1", "1750000100.000000")).toBe("https://acme.slack.com/archives/C1/p1750000100000000");
    expect(slackArchiveUrl("https://acme.slack.com", "C1", "1750000100.000000")).toBe("https://acme.slack.com/archives/C1/p1750000100000000");
  });

  it("adds thread context for a reply", () => {
    expect(slackArchiveUrl("https://acme.slack.com/", "C1", "1750000150.000000", "1750000100.000000")).toBe(
      "https://acme.slack.com/archives/C1/p1750000150000000?thread_ts=1750000100.000000&cid=C1",
    );
  });

  it("returns undefined without a workspace URL (caller falls back to the client link)", () => {
    expect(slackArchiveUrl(undefined, "C1", "1750000100.000000")).toBeUndefined();
    expect(slackArchiveUrl("", "C1", "1750000100.000000")).toBeUndefined();
  });

  it("does not add thread params when the message is the thread root", () => {
    expect(slackArchiveUrl("https://acme.slack.com/", "C1", "1750000100.000000", "1750000100.000000")).toBe(
      "https://acme.slack.com/archives/C1/p1750000100000000",
    );
  });
});

describe("normalizeSlackMessage", () => {
  const ctx = { channelId: "C1", teamId: "T1", selfId: "USELF", timezone: "Asia/Kolkata", label: "#general" };

  it("drops noise subtypes and message-less rows", () => {
    expect(normalizeSlackMessage({ type: "message", subtype: "channel_join", text: "x", ts: "1.0" }, ctx)).toBeNull();
    expect(normalizeSlackMessage({ type: "message", text: "", ts: "1.0" }, ctx)).toBeNull();
    expect(normalizeSlackMessage({ type: "message", text: "hi", ts: undefined }, ctx)).toBeNull();
  });

  it("marks fromMe and carries threadTs", () => {
    const mine = normalizeSlackMessage({ type: "message", user: "USELF", text: "I'll send it", ts: "1750000600.000000", thread_ts: "1750000100.000000" }, ctx);
    expect(mine?.fromMe).toBe(true);
    expect(mine?.threadTs).toBe("1750000100.000000");
    const theirs = normalizeSlackMessage({ type: "message", user: "U2", text: "ping", ts: "1750000600.000000" }, ctx);
    expect(theirs?.fromMe).toBe(false);
  });
});
