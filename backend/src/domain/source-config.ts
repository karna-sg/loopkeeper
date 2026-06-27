/**
 * User-tunable ingestion config. DMs and @mentions are always read; `slackChannelIds` adds
 * specific channels to watch. `gmailQuery` controls which mail is scanned (importance filter).
 */
/** "all_member" = read every channel you're in (catches @channel/@here everywhere);
 *  "selected" = read only the channels you toggled on. DMs + @mentions are always read. */
export type SlackScope = "all_member" | "selected";

export interface SourceConfig {
  slackScope: SlackScope;
  slackChannelIds: string[];
  gmailQuery: string;
}

/** Primary-tab mail only (excludes Promotions/Social/Updates/Forums) — the high-signal default. */
export const DEFAULT_GMAIL_QUERY = "in:inbox category:primary newer_than:7d";

export const DEFAULT_SOURCE_CONFIG: SourceConfig = {
  slackScope: "all_member",
  slackChannelIds: [],
  gmailQuery: DEFAULT_GMAIL_QUERY,
};

/** Named Gmail importance presets the app can offer. */
export const GMAIL_PRESETS: Readonly<Record<string, string>> = {
  primary: "in:inbox category:primary newer_than:7d",
  important: "in:inbox is:important newer_than:7d",
  all: "in:inbox newer_than:7d",
};
