import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EncryptedFileVault, InMemoryVault } from "../../src/vault/token-vault.ts";

function tempVault(): EncryptedFileVault {
  const dir = mkdtempSync(join(tmpdir(), "lk-vault-"));
  return new EncryptedFileVault(join(dir, "tokens.enc"), randomBytes(32));
}

describe("EncryptedFileVault", () => {
  it("round-trips a token through encryption", () => {
    const vault = tempVault();
    vault.set("google", "me@example.com", { accessToken: "AT", refreshToken: "RT", expiresAt: "2026-06-26T00:00:00Z" });
    const got = vault.get("google", "me@example.com");
    expect(got?.accessToken).toBe("AT");
    expect(got?.refreshToken).toBe("RT");
  });

  it("does not store the plaintext token on disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "lk-vault-"));
    const path = join(dir, "tokens.enc");
    const vault = new EncryptedFileVault(path, randomBytes(32));
    vault.set("slack", "T1", { accessToken: "xoxp-supersecret-value" });
    expect(readFileSync(path, "utf8")).not.toContain("xoxp-supersecret-value");
  });

  it("fails to decrypt if the file is tampered with", () => {
    const dir = mkdtempSync(join(tmpdir(), "lk-vault-"));
    const path = join(dir, "tokens.enc");
    const vault = new EncryptedFileVault(path, randomBytes(32));
    vault.set("slack", "T1", { accessToken: "AT" });
    writeFileSync(path, Buffer.from("garbage-not-a-valid-blob").toString("base64"));
    expect(() => vault.get("slack", "T1")).toThrow();
  });

  it("lists and deletes entries", () => {
    const vault = tempVault();
    vault.set("slack", "T1", { accessToken: "a" });
    vault.set("google", "me@x.com", { accessToken: "b" });
    expect(vault.list()).toHaveLength(2);
    vault.delete("slack", "T1");
    expect(vault.list()).toEqual([{ provider: "google", account: "me@x.com" }]);
  });
});

describe("InMemoryVault", () => {
  it("round-trips", () => {
    const vault = new InMemoryVault();
    vault.set("slack", "T1", { accessToken: "a" });
    expect(vault.get("slack", "T1")?.accessToken).toBe("a");
    expect(vault.list()).toEqual([{ provider: "slack", account: "T1" }]);
  });
});
