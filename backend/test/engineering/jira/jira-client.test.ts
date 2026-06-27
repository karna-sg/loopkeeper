import { describe, expect, it } from "vitest";
import { BasicJiraClient } from "../../../src/engineering/jira/jira-client.ts";
import type { HttpClient } from "../../../src/oauth/http.ts";

/** Captures the URL + headers each request was made with. */
function recordingHttp(responses: Record<string, unknown>): { http: HttpClient; calls: Array<{ url: string; headers?: Record<string, string> }> } {
  const calls: Array<{ url: string; headers?: Record<string, string> }> = [];
  const http: HttpClient = {
    post: async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "" }),
    getJson: async (url, headers) => {
      calls.push({ url, ...(headers ? { headers } : {}) });
      const key = Object.keys(responses).find((k) => url.includes(k));
      return key ? responses[key] : {};
    },
  };
  return { http, calls };
}

describe("BasicJiraClient", () => {
  it("hits the site REST base with Basic auth and parses issues", async () => {
    const { http, calls } = recordingHttp({
      "/search/jql": { issues: [{ id: "1", key: "LK-1", fields: { summary: "Do it" } }, { id: "2", key: "LK-2", fields: {} }] },
    });
    const client = new BasicJiraClient(http, "https://acme.atlassian.net/", "me@acme.com", "tok123");
    const issues = await client.searchAssigned();

    expect(issues.map((i) => i.key)).toEqual(["LK-1", "LK-2"]);
    const call = calls[0]!;
    expect(call.url).toContain("https://acme.atlassian.net/rest/api/3/search/jql");
    expect(call.url).toContain("assignee%20%3D%20currentUser()");
    expect(call.headers?.authorization).toBe(`Basic ${Buffer.from("me@acme.com:tok123").toString("base64")}`);
  });

  it("reads the account id from /myself", async () => {
    const { http } = recordingHttp({ "/myself": { accountId: "acct-xyz" } });
    const client = new BasicJiraClient(http, "https://acme.atlassian.net", "me@acme.com", "tok");
    expect(await client.currentUserAccountId()).toBe("acct-xyz");
  });
});
