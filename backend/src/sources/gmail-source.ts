import type { HttpClient } from "../oauth/http.ts";
import type { NormalizedMessage, UserIdentity } from "../domain/message.ts";
import type { MessageSource, TokenProvider } from "./source.ts";
import { redactSecrets } from "../redact.ts";
import { DEFAULT_GMAIL_QUERY } from "../domain/source-config.ts";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const MAX_TEXT = 4000;

interface GmailPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
}
interface GmailHeader {
  name: string;
  value: string;
}
interface GmailMessage {
  id: string;
  threadId: string;
  internalDate?: string;
  payload?: GmailPart & { headers?: GmailHeader[] };
}

function header(msg: GmailMessage, name: string): string {
  return msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

/** Recursively pull the best text body (prefer text/plain) from a Gmail payload. */
function decodeBody(part: GmailPart | undefined): string {
  if (!part) return "";
  if (part.mimeType === "text/plain" && part.body?.data) {
    return Buffer.from(part.body.data, "base64url").toString("utf8");
  }
  if (part.parts) {
    const plain = part.parts.map(decodeBody).find((t) => t.trim() !== "");
    if (plain) return plain;
  }
  if (part.body?.data) return Buffer.from(part.body.data, "base64url").toString("utf8");
  return "";
}

/** Read-only Gmail ingestion via the REST API. */
export class GmailSource implements MessageSource {
  readonly channel = "gmail" as const;
  readonly #http: HttpClient;
  readonly #token: TokenProvider;
  readonly #identity: UserIdentity;
  readonly #account: string;
  readonly #query: string;

  constructor(http: HttpClient, token: TokenProvider, identity: UserIdentity, account: string, query = DEFAULT_GMAIL_QUERY) {
    this.#http = http;
    this.#token = token;
    this.#identity = identity;
    this.#account = account;
    this.#query = query;
  }

  #normalize(msg: GmailMessage): NormalizedMessage {
    const from = header(msg, "From");
    const subject = header(msg, "Subject");
    const dateHeader = header(msg, "Date");
    const ts = dateHeader ? new Date(dateHeader).toISOString() : new Date(Number(msg.internalDate ?? 0)).toISOString();
    const self = [this.#account, ...this.#identity.aliases].map((s) => s.toLowerCase());
    const body = decodeBody(msg.payload).slice(0, MAX_TEXT);
    return {
      channel: "gmail",
      tenant: this.#account,
      sourceRef: `${msg.threadId}:${msg.id}`,
      permalink: `https://mail.google.com/mail/u/0/#inbox/${msg.threadId}`,
      author: from || "unknown",
      fromMe: self.some((s) => s && from.toLowerCase().includes(s)),
      timestamp: ts,
      sourceTimezone: this.#identity.timezone,
      text: redactSecrets(`${subject}\n${body}`.trim()),
    };
  }

  async fetchRecent({ limit }: { sinceIso: string; limit: number }): Promise<NormalizedMessage[]> {
    const auth = { authorization: `Bearer ${await this.#token()}` };
    const list = (await this.#http.getJson(
      `${API}/messages?maxResults=${limit}&q=${encodeURIComponent(this.#query)}`,
      auth,
    )) as { messages?: Array<{ id: string }> };
    const out: NormalizedMessage[] = [];
    for (const ref of list.messages ?? []) {
      const full = (await this.#http.getJson(`${API}/messages/${ref.id}?format=full`, auth)) as GmailMessage;
      out.push(this.#normalize(full));
    }
    return out;
  }
}
