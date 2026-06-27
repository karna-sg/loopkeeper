import { connect } from "node:http2";
import { sign } from "node:crypto";
import type { NudgePayload, PushSender } from "./push-sender.ts";

/** Token-based APNs credentials (a .p8 key from the Apple Developer portal). */
export interface ApnsConfig {
  keyId: string;
  teamId: string;
  bundleId: string;
  /** PEM contents of the AuthKey_XXXX.p8 (PKCS#8 EC private key). */
  p8Pem: string;
  production: boolean;
}

const JWT_TTL_MS = 50 * 60 * 1000; // refresh before APNs' 60-min limit

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * Minimal token-based APNs sender over HTTP/2. Not exercised by the test suite (needs a real
 * key + device); the {@link FakePushSender} covers the nudge logic. Payloads carry no quotes.
 */
export class ApnsClient implements PushSender {
  readonly #cfg: ApnsConfig;
  #jwt: { token: string; mintedAtMs: number } | null = null;

  constructor(cfg: ApnsConfig) {
    this.#cfg = cfg;
  }

  #authToken(nowMs: number = Date.now()): string {
    if (this.#jwt && nowMs - this.#jwt.mintedAtMs < JWT_TTL_MS) return this.#jwt.token;
    const header = base64url(JSON.stringify({ alg: "ES256", kid: this.#cfg.keyId }));
    const claims = base64url(JSON.stringify({ iss: this.#cfg.teamId, iat: Math.floor(nowMs / 1000) }));
    const signingInput = `${header}.${claims}`;
    const signature = sign("sha256", Buffer.from(signingInput), { key: this.#cfg.p8Pem, dsaEncoding: "ieee-p1363" });
    const token = `${signingInput}.${base64url(signature)}`;
    this.#jwt = { token, mintedAtMs: nowMs };
    return token;
  }

  async send(deviceToken: string, payload: NudgePayload): Promise<void> {
    const host = this.#cfg.production ? "https://api.push.apple.com" : "https://api.sandbox.push.apple.com";
    const client = connect(host);
    try {
      await new Promise<void>((resolve, reject) => {
        const body = JSON.stringify({
          aps: { alert: { title: payload.title, body: payload.body }, sound: "default", ...(payload.badge === undefined ? {} : { badge: payload.badge }) },
          ...(payload.loopId ? { loopId: payload.loopId } : {}),
          ...(payload.threadRef ? { threadRef: payload.threadRef } : {}),
          ...(payload.taskId ? { taskId: payload.taskId } : {}),
          ...(payload.stage ? { stage: payload.stage } : {}),
        });
        const req = client.request({
          ":method": "POST",
          ":path": `/3/device/${deviceToken}`,
          authorization: `bearer ${this.#authToken()}`,
          "apns-topic": this.#cfg.bundleId,
          "apns-push-type": "alert",
          "content-type": "application/json",
        });
        let status = 0;
        let respBody = "";
        req.on("response", (headers) => {
          status = Number(headers[":status"] ?? 0);
        });
        req.setEncoding("utf8");
        req.on("data", (chunk: string) => (respBody += chunk));
        req.on("end", () => (status >= 200 && status < 300 ? resolve() : reject(new Error(`APNs ${status}: ${respBody}`))));
        req.on("error", reject);
        req.end(body);
      });
    } finally {
      client.close();
    }
  }
}
