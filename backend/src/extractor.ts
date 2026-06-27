import Anthropic from "@anthropic-ai/sdk";
import type { ExtractedLoop, OpenLoop } from "./domain/open-loop.ts";
import { DIRECTIONS, FIRMNESS, LOOP_KINDS } from "./domain/open-loop.ts";
import type { NormalizedMessage, UserIdentity } from "./domain/message.ts";
import { resolveDueDate } from "./due-date.ts";
import { commitmentHash, dedupeLoops, loopId } from "./dedupe.ts";
import { redactSecrets } from "./redact.ts";
import type { GateCandidate } from "./gate.ts";
import { EXTRACTION_SYSTEM_PROMPT, LOOP_TOOL_NAME, LOOP_TOOL_PARAMETERS } from "./llm/loop-schema.ts";

/**
 * Turns gated candidate messages into `open_loop` rows. The LLM call is hidden behind the
 * {@link ExtractionClient} interface so the orchestration (parse → resolve date → hash →
 * redact → dedupe) is unit-testable with a fake client and never needs the network.
 */

export interface ExtractionInput {
  message: NormalizedMessage;
  identity: UserIdentity;
}

export interface ExtractionClient {
  extract(input: ExtractionInput): Promise<ExtractedLoop[]>;
}

export interface BuildOptions {
  /** Reference instant (ISO). Passed in so output is deterministic. */
  nowIso: string;
  /** Persist a short verbatim excerpt of the commitment. Default false (third-party data). */
  includeQuoteExcerpt?: boolean;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Pure mapping from model output to persisted rows for a single source message.
 * Applies redaction to every persisted field and resolves the due phrase deterministically.
 */
export function buildOpenLoops(
  extracted: readonly ExtractedLoop[],
  message: NormalizedMessage,
  identity: UserIdentity,
  options: BuildOptions,
): OpenLoop[] {
  const includeQuote = options.includeQuoteExcerpt ?? false;
  return extracted.map((e) => {
    const hash = commitmentHash(e.commitmentSpan);
    const { dueDate, dueConfidence } = resolveDueDate(e.duePhrase, options.nowIso, identity.timezone);
    const key = {
      channel: message.channel,
      sourceRef: message.sourceRef,
      direction: e.direction,
      commitmentHash: hash,
    };
    const loop: OpenLoop = {
      id: loopId(key),
      direction: e.direction,
      kind: e.kind,
      summary: redactSecrets(e.summary),
      counterpart: redactSecrets(e.counterpart),
      channel: message.channel,
      sourceRef: message.sourceRef,
      permalink: message.permalink,
      commitmentHash: hash,
      dueDate,
      dueConfidence,
      firmness: e.firmness,
      status: "open",
      tenant: message.tenant,
      createdTs: options.nowIso,
    };
    if (includeQuote) loop.quoteExcerpt = redactSecrets(truncate(e.commitmentSpan, 240));
    if (message.sourceLabel) loop.sourceLabel = message.sourceLabel;
    if (message.threadTs) loop.threadTs = message.threadTs;
    return loop;
  });
}

export interface ExtractRunOptions {
  nowIso: string;
  identity: UserIdentity;
  includeQuoteExcerpt?: boolean;
}

/** Run every candidate through the model and collect deduped loops. */
export async function extractLoops(
  candidates: readonly GateCandidate[],
  client: ExtractionClient,
  options: ExtractRunOptions,
): Promise<OpenLoop[]> {
  const all: OpenLoop[] = [];
  for (const candidate of candidates) {
    const extracted = await client.extract({ message: candidate.message, identity: options.identity });
    all.push(
      ...buildOpenLoops(extracted, candidate.message, options.identity, {
        nowIso: options.nowIso,
        includeQuoteExcerpt: options.includeQuoteExcerpt,
      }),
    );
  }
  return dedupeLoops(all);
}

// ---------------------------------------------------------------------------
// Validation of untrusted model output
// ---------------------------------------------------------------------------

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

/** Validate a single raw loop from the model; returns `[loop]` or `[]` if malformed. */
export function validateExtracted(raw: unknown): ExtractedLoop[] {
  if (typeof raw !== "object" || raw === null) return [];
  const r = raw as Record<string, unknown>;
  if (!isOneOf(r.direction, DIRECTIONS)) return [];
  if (!isOneOf(r.kind, LOOP_KINDS)) return [];
  if (!isOneOf(r.firmness, FIRMNESS)) return [];
  if (typeof r.summary !== "string" || typeof r.counterpart !== "string") return [];
  if (typeof r.commitmentSpan !== "string" || r.commitmentSpan.trim() === "") return [];
  const duePhrase = r.duePhrase;
  if (duePhrase !== null && typeof duePhrase !== "string") return [];
  return [
    {
      direction: r.direction,
      kind: r.kind,
      firmness: r.firmness,
      summary: r.summary,
      counterpart: r.counterpart,
      commitmentSpan: r.commitmentSpan,
      duePhrase: duePhrase ?? null,
    },
  ];
}

// ---------------------------------------------------------------------------
// Real Claude-backed client
// ---------------------------------------------------------------------------

const TOOL: Anthropic.Tool = {
  name: LOOP_TOOL_NAME,
  description: "Record the open loops (commitments / requests / action items) found in the message.",
  input_schema: LOOP_TOOL_PARAMETERS as unknown as Anthropic.Tool["input_schema"],
};

export interface AnthropicClientOptions {
  apiKey?: string;
  model?: string;
  maxTokens?: number;
}

/** Default extraction model — balances precision and cost for Phase-0 measurement. */
export const DEFAULT_EXTRACTION_MODEL = "claude-sonnet-4-6";

export function renderMessage(message: NormalizedMessage, identity: UserIdentity): string {
  const who = message.fromMe ? `${identity.displayName} (the user)` : message.author;
  // Defence in depth: never send secret-shaped values to the model.
  const body = redactSecrets(message.text);
  return [
    `User identity: ${identity.displayName} (aliases: ${identity.aliases.join(", ") || "none"})`,
    `Channel: ${message.channel}`,
    `From: ${who}`,
    `Sent: ${message.timestamp}`,
    "",
    body,
  ].join("\n");
}

/** Production extraction client backed by the Anthropic Messages API with prompt caching. */
export class AnthropicExtractionClient implements ExtractionClient {
  readonly #client: Anthropic;
  readonly #model: string;
  readonly #maxTokens: number;

  constructor(options: AnthropicClientOptions = {}) {
    this.#client = new Anthropic(options.apiKey ? { apiKey: options.apiKey } : {});
    this.#model = options.model ?? DEFAULT_EXTRACTION_MODEL;
    this.#maxTokens = options.maxTokens ?? 1024;
  }

  async extract({ message, identity }: ExtractionInput): Promise<ExtractedLoop[]> {
    const response = await this.#client.messages.create({
      model: this.#model,
      max_tokens: this.#maxTokens,
      system: [{ type: "text", text: EXTRACTION_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      tools: [TOOL],
      tool_choice: { type: "tool", name: LOOP_TOOL_NAME },
      messages: [{ role: "user", content: renderMessage(message, identity) }],
    });

    const block = response.content.find((b) => b.type === "tool_use" && b.name === LOOP_TOOL_NAME);
    if (!block || block.type !== "tool_use") return [];
    const input = block.input as { loops?: unknown };
    return Array.isArray(input.loops) ? input.loops.flatMap(validateExtracted) : [];
  }
}
