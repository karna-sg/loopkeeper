import { describe, expect, it } from "vitest";
import { REDACTION_PLACEHOLDER, containsSecret, redactSecrets } from "../src/redact.ts";

describe("redactSecrets", () => {
  it("redacts an Anthropic key", () => {
    const out = redactSecrets("deploy key sk-ant-abcdefghijklmnopqrstuvwxyz0123456789");
    expect(out).toBe(`deploy key ${REDACTION_PLACEHOLDER}`);
  });

  it("redacts a Slack token", () => {
    expect(redactSecrets("token xoxb-123456789012-abcdEFGHijkl")).toContain(REDACTION_PLACEHOLDER);
  });

  it("redacts a GitHub PAT", () => {
    expect(redactSecrets("ghp_abcdefghijklmnopqrstuvwxyz0123456789")).toBe(REDACTION_PLACEHOLDER);
  });

  it("redacts an AWS access key id", () => {
    expect(redactSecrets("id AKIAIOSFODNN7EXAMPLE here")).toContain(REDACTION_PLACEHOLDER);
  });

  it("redacts a Bearer header", () => {
    expect(redactSecrets("Authorization: Bearer abcdefghijklmnopqrstuvwxyz")).toContain(REDACTION_PLACEHOLDER);
  });

  it("redacts a labelled secret blob", () => {
    expect(redactSecrets("api_key=ABCdef1234567890ABCdef1234")).toBe(REDACTION_PLACEHOLDER);
  });

  it("redacts a JWT", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N";
    expect(redactSecrets(`token ${jwt}`)).toContain(REDACTION_PLACEHOLDER);
  });

  it("redacts a fine-grained GitHub PAT and a GitLab PAT", () => {
    expect(redactSecrets("github_pat_11ABCDE0123456789_abcdefghijklmnopqrstuvwxyz")).toContain(REDACTION_PLACEHOLDER);
    expect(redactSecrets("glpat-abcdefghijklmnopqrst")).toContain(REDACTION_PLACEHOLDER);
  });

  it("redacts an OpenSSH private key block (Phase 2 deploy/GitHub App keys)", () => {
    const key = [
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gt",
      "ZWQyNTUxOQAAACDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      "-----END OPENSSH PRIVATE KEY-----",
    ].join("\n");
    const out = redactSecrets(`deploy key:\n${key}\nlog continues`);
    expect(out).toContain(REDACTION_PLACEHOLDER);
    expect(out).not.toContain("BEGIN OPENSSH");
    expect(out).toContain("log continues");
  });

  it("leaves ordinary prose untouched", () => {
    const prose = "Send Priya the RFC by Friday and review the API key documentation page.";
    expect(redactSecrets(prose)).toBe(prose);
  });

  it("returns empty input unchanged", () => {
    expect(redactSecrets("")).toBe("");
  });

  it("containsSecret reports correctly without being thrown off by global-flag state", () => {
    expect(containsSecret("ghp_abcdefghijklmnopqrstuvwxyz0123456789")).toBe(true);
    expect(containsSecret("ghp_abcdefghijklmnopqrstuvwxyz0123456789")).toBe(true);
    expect(containsSecret("just a normal sentence")).toBe(false);
  });
});
