import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { OpenLoop } from "../domain/open-loop.ts";
import { redactSecrets } from "../redact.ts";
import { DEFAULT_EXTRACTION_MODEL } from "../extractor.ts";
import { DEFAULT_OPENAI_MODEL } from "../openai-extractor.ts";
import { DRAFT_SYSTEM_PROMPT } from "../llm/loop-schema.ts";

/**
 * Composes suggested follow-up text. This NEVER sends — the text is returned to the app for the
 * user to review and send from their own client. No counterpart words are quoted back to them.
 */
export interface DraftClient {
  draftChaser(loop: OpenLoop): Promise<string>;
}

/** Deterministic stand-in for tests / offline. */
export class FakeDraftClient implements DraftClient {
  async draftChaser(loop: OpenLoop): Promise<string> {
    const due = loop.dueDate ? ` (due ${loop.dueDate})` : "";
    return `Hi ${loop.counterpart}, just following up on: ${loop.summary}${due}. Let me know — thanks!`;
  }
}

function userPrompt(loop: OpenLoop): string {
  return `Counterpart: ${loop.counterpart}\nOutstanding item: ${loop.summary}\nDue: ${loop.dueDate ?? "unspecified"}\nWrite the follow-up.`;
}

export interface DraftClientOptions {
  apiKey?: string;
  model?: string;
}

export class AnthropicDraftClient implements DraftClient {
  readonly #client: Anthropic;
  readonly #model: string;

  constructor(options: DraftClientOptions = {}) {
    this.#client = new Anthropic(options.apiKey ? { apiKey: options.apiKey } : {});
    this.#model = options.model ?? DEFAULT_EXTRACTION_MODEL;
  }

  async draftChaser(loop: OpenLoop): Promise<string> {
    const response = await this.#client.messages.create({
      model: this.#model,
      max_tokens: 300,
      system: [{ type: "text", text: DRAFT_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: userPrompt(loop) }],
    });
    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim();
    return redactSecrets(text);
  }
}

export class OpenAIDraftClient implements DraftClient {
  readonly #client: OpenAI;
  readonly #model: string;

  constructor(options: DraftClientOptions = {}) {
    this.#client = new OpenAI(options.apiKey ? { apiKey: options.apiKey } : {});
    this.#model = options.model ?? DEFAULT_OPENAI_MODEL;
  }

  async draftChaser(loop: OpenLoop): Promise<string> {
    const response = await this.#client.chat.completions.create({
      model: this.#model,
      messages: [
        { role: "system", content: DRAFT_SYSTEM_PROMPT },
        { role: "user", content: userPrompt(loop) },
      ],
    });
    return redactSecrets((response.choices[0]?.message.content ?? "").trim());
  }
}
