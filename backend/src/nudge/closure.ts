import type { NormalizedMessage } from "../domain/message.ts";
import type { OpenLoop } from "../domain/open-loop.ts";

/** Completion language in a follow-up message from the user (incl. Hinglish). */
const COMPLETION = [
  /\b(done|sent|shipped|pushed|merged|completed|finished|submitted|delivered|fixed|resolved|handled)\b/i,
  /\b(kar diya|bhej diya|ho gaya|de diya|complete kar diya)\b/i,
];

function channelIdOf(sourceRef: string): string {
  const i = sourceRef.indexOf(":");
  return i < 0 ? sourceRef : sourceRef.slice(0, i);
}

function isDm(label: string | undefined): boolean {
  return label === "DM" || label === "Group DM";
}

/**
 * Suggest which open OWE loops look resolved, based on a later message FROM THE USER asserting
 * completion. Scoped to the SAME Slack thread (thread_ts) — or, for a DM/group-DM, the same
 * conversation — so a single "done" can no longer mis-close every open loop in a busy channel.
 * Returns loop ids to mark `closed_candidate`.
 *
 * Conservative by design: this NEVER auto-closes — the existence of a reply is not proof of
 * completion, so we surface candidates for the user to confirm and default to leaving loops open.
 * A top-level completion in a regular channel (no thread) closes nothing — too ambiguous.
 */
export function detectClosures(messages: readonly NormalizedMessage[], openLoops: readonly OpenLoop[]): string[] {
  const doneThreads = new Set<string>();
  const doneDmChannels = new Set<string>();
  for (const m of messages) {
    if (!m.fromMe || !COMPLETION.some((r) => r.test(m.text))) continue;
    if (m.threadTs) doneThreads.add(m.threadTs);
    if (isDm(m.sourceLabel)) doneDmChannels.add(channelIdOf(m.sourceRef));
  }
  if (doneThreads.size === 0 && doneDmChannels.size === 0) return [];
  return openLoops
    .filter((l) => l.direction === "owe" && l.status === "open")
    .filter(
      (l) =>
        (l.threadTs !== undefined && doneThreads.has(l.threadTs)) ||
        (isDm(l.sourceLabel) && doneDmChannels.has(channelIdOf(l.sourceRef))),
    )
    .map((l) => l.id);
}
