import type { Channel } from "./open-loop.ts";

/**
 * A channel-agnostic message shape. Slack events and Gmail threads are normalized to
 * this before they reach the gate or the extractor, so downstream code never has to
 * know which channel a message came from.
 */
export interface NormalizedMessage {
  channel: Channel;
  /** Workspace id / account email — the per-source allowlist key. */
  tenant: string;
  /** Stable per-source identity: slack `channel:ts`, gmail `threadId:messageId`. */
  sourceRef: string;
  permalink: string;
  /** Display handle/name of the sender. */
  author: string;
  /** Human-readable origin shown in the UI: Slack "#channel" / "DM" / "Group DM"; undefined for email. */
  sourceLabel?: string;
  /** Slack thread root ts when this message belongs to a thread (own ts if it's the root); used to scope closure. */
  threadTs?: string;
  /** Edit version (Slack `edited.ts`) when the message was edited; folds into the seen-key so edits re-extract. */
  editedTs?: string;
  /** True when the signed-in user authored this message (drives owe-vs-owed). */
  fromMe: boolean;
  /** ISO timestamp of the message. */
  timestamp: string;
  /** IANA timezone of the sender/source if known; the parser falls back to the user's. */
  sourceTimezone: string;
  /** Plain-text body. */
  text: string;
}

/**
 * The key under which a message is tracked as "already processed". Normally the stable
 * sourceRef, but an edited message folds its edit version in so editing a message (e.g. to
 * add a deadline) makes it look unseen and re-extracts. The sourceRef itself stays stable,
 * so permalinks, dedupe, and closure are unaffected.
 */
export function messageSeenKey(message: Pick<NormalizedMessage, "sourceRef" | "editedTs">): string {
  return message.editedTs ? `${message.sourceRef}#${message.editedTs}` : message.sourceRef;
}

/** Who "I"/"you"/"me" resolve to during extraction. */
export interface UserIdentity {
  displayName: string;
  /** Other handles/emails that also mean "me" (slack id, alt emails). */
  aliases: readonly string[];
  /** The user's home IANA timezone, e.g. "Asia/Kolkata". */
  timezone: string;
}
