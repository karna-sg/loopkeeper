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

  it("paginates: follows nextPageToken until isLast and aggregates every page", async () => {
    const calls: string[] = [];
    const http: HttpClient = {
      post: async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "" }),
      getJson: async (url) => {
        calls.push(url);
        if (url.includes("nextPageToken=tok1")) {
          return { issues: [{ id: "3", key: "LK-3", fields: {} }], isLast: true };
        }
        return { issues: [{ id: "1", key: "LK-1", fields: {} }, { id: "2", key: "LK-2", fields: {} }], nextPageToken: "tok1" };
      },
    };
    const client = new BasicJiraClient(http, "https://acme.atlassian.net", "me@acme.com", "tok");
    const issues = await client.searchAssigned();

    expect(issues.map((i) => i.key)).toEqual(["LK-1", "LK-2", "LK-3"]); // both pages, in order
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("maxResults=100");
    expect(calls[0]).not.toContain("nextPageToken");
    expect(calls[1]).toContain("nextPageToken=tok1");
  });

  it("stops on a repeated nextPageToken (defends against the looping-token bug, never hangs)", async () => {
    let n = 0;
    const http: HttpClient = {
      post: async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "" }),
      getJson: async () => {
        n += 1;
        // Pathological server: always the same token, never isLast.
        return { issues: [{ id: String(n), key: `LK-${n}`, fields: {} }], nextPageToken: "same" };
      },
    };
    const client = new BasicJiraClient(http, "https://acme.atlassian.net", "me@acme.com", "tok");
    const issues = await client.searchAssigned();

    expect(n).toBe(2); // page 0 records the token, page 1 sees it repeat and breaks
    expect(issues.map((i) => i.key)).toEqual(["LK-1", "LK-2"]);
  });

  it("reads the account id from /myself", async () => {
    const { http } = recordingHttp({ "/myself": { accountId: "acct-xyz" } });
    const client = new BasicJiraClient(http, "https://acme.atlassian.net", "me@acme.com", "tok");
    expect(await client.currentUserAccountId()).toBe("acct-xyz");
  });
});
