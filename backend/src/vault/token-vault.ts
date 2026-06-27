import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * OAuth tokens for one provider+account. Values are secrets — never log them.
 */
export interface StoredToken {
  accessToken: string;
  refreshToken?: string;
  /** ISO expiry of the access token, if known. */
  expiresAt?: string;
  scope?: string;
  meta?: Record<string, string>;
}

export interface TokenVault {
  set(provider: string, account: string, token: StoredToken): void;
  get(provider: string, account: string): StoredToken | null;
  delete(provider: string, account: string): void;
  list(): Array<{ provider: string; account: string }>;
}

const KEY_BYTES = 32;
const IV_BYTES = 12;

/**
 * Resolve the AES master key. Prefers an explicit base64 env key; otherwise generates one
 * and persists it (0600) under the data dir, so single-user tokens survive restarts.
 */
export function resolveMasterKey(dataDir: string, masterKeyB64: string | null): Buffer {
  if (masterKeyB64) {
    const key = Buffer.from(masterKeyB64, "base64");
    if (key.length !== KEY_BYTES) throw new Error(`LOOPKEEPER_MASTER_KEY must decode to ${KEY_BYTES} bytes`);
    return key;
  }
  mkdirSync(dataDir, { recursive: true });
  const keyPath = join(dataDir, "master.key");
  if (existsSync(keyPath)) {
    return Buffer.from(readFileSync(keyPath, "utf8").trim(), "base64");
  }
  const key = randomBytes(KEY_BYTES);
  writeFileSync(keyPath, key.toString("base64"), { mode: 0o600 });
  chmodSync(keyPath, 0o600);
  return key;
}

type VaultMap = Record<string, StoredToken>;

/**
 * AES-256-GCM encrypted, file-backed vault. The whole token map is encrypted as one blob
 * (single-user, low volume). Tampering fails decryption (GCM auth tag).
 */
export class EncryptedFileVault implements TokenVault {
  readonly #path: string;
  readonly #key: Buffer;

  constructor(path: string, key: Buffer) {
    this.#path = path;
    this.#key = key;
  }

  #encrypt(map: VaultMap): void {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    const plaintext = Buffer.from(JSON.stringify(map), "utf8");
    const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    mkdirSync(dirname(this.#path), { recursive: true });
    writeFileSync(this.#path, Buffer.concat([iv, tag, enc]).toString("base64"), { mode: 0o600 });
  }

  #decrypt(): VaultMap {
    if (!existsSync(this.#path)) return {};
    const buf = Buffer.from(readFileSync(this.#path, "utf8"), "base64");
    const iv = buf.subarray(0, IV_BYTES);
    const tag = buf.subarray(IV_BYTES, IV_BYTES + 16);
    const data = buf.subarray(IV_BYTES + 16);
    const decipher = createDecipheriv("aes-256-gcm", this.#key, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(data), decipher.final()]);
    return JSON.parse(dec.toString("utf8")) as VaultMap;
  }

  static #mapKey(provider: string, account: string): string {
    return `${provider}:${account}`;
  }

  set(provider: string, account: string, token: StoredToken): void {
    const map = this.#decrypt();
    map[EncryptedFileVault.#mapKey(provider, account)] = token;
    this.#encrypt(map);
  }

  get(provider: string, account: string): StoredToken | null {
    return this.#decrypt()[EncryptedFileVault.#mapKey(provider, account)] ?? null;
  }

  delete(provider: string, account: string): void {
    const map = this.#decrypt();
    delete map[EncryptedFileVault.#mapKey(provider, account)];
    this.#encrypt(map);
  }

  list(): Array<{ provider: string; account: string }> {
    return Object.keys(this.#decrypt()).map((k) => {
      const idx = k.indexOf(":");
      return { provider: k.slice(0, idx), account: k.slice(idx + 1) };
    });
  }
}

/** In-memory vault for tests. */
export class InMemoryVault implements TokenVault {
  readonly #map = new Map<string, StoredToken>();
  set(provider: string, account: string, token: StoredToken): void {
    this.#map.set(`${provider}:${account}`, token);
  }
  get(provider: string, account: string): StoredToken | null {
    return this.#map.get(`${provider}:${account}`) ?? null;
  }
  delete(provider: string, account: string): void {
    this.#map.delete(`${provider}:${account}`);
  }
  list(): Array<{ provider: string; account: string }> {
    return [...this.#map.keys()].map((k) => {
      const idx = k.indexOf(":");
      return { provider: k.slice(0, idx), account: k.slice(idx + 1) };
    });
  }
}
