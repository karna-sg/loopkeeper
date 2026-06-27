import type { NormalizedMessage } from "../domain/message.ts";
import type { Channel } from "../domain/open-loop.ts";

/** Returns a fresh, valid access token for a source (handles refresh upstream). */
export type TokenProvider = () => Promise<string>;

/** A read-only ingestion source that yields normalized recent messages for one channel. */
export interface MessageSource {
  readonly channel: Channel;
  fetchRecent(opts: { sinceIso: string; limit: number }): Promise<NormalizedMessage[]>;
  /** Optional: coverage warnings (degraded search, truncation) from the most recent fetch, drained by the scanner. */
  drainWarnings?(): string[];
}
