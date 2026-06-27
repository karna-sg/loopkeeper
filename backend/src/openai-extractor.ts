import OpenAI from "openai";
import type { ExtractedLoop } from "./domain/open-loop.ts";
import type { ExtractionClient, ExtractionInput } from "./extractor.ts";
import { renderMessage, validateExtracted } from "./extractor.ts";
import { EXTRACTION_SYSTEM_PROMPT, LOOP_TOOL_NAME, LOOP_TOOL_PARAMETERS } from "./llm/loop-schema.ts";

export const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";

/** Pure parse of a function-call arguments JSON into validated loops. Testable without the SDK. */
export function loopsFromToolArguments(argumentsJson: string | undefined): ExtractedLoop[] {
  if (!argumentsJson) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const loops = (parsed as { loops?: unknown }).loops;
  return Array.isArray(loops) ? loops.flatMap(validateExtracted) : [];
}

export interface OpenAIClientOptions {
  apiKey?: string;
  model?: string;
}

/** Extraction client backed by OpenAI chat completions with forced function calling. */
export class OpenAIExtractionClient implements ExtractionClient {
  readonly #client: OpenAI;
  readonly #model: string;

  constructor(options: OpenAIClientOptions = {}) {
    this.#client = new OpenAI(options.apiKey ? { apiKey: options.apiKey } : {});
    this.#model = options.model ?? DEFAULT_OPENAI_MODEL;
  }

  async extract({ message, identity }: ExtractionInput): Promise<ExtractedLoop[]> {
    const response = await this.#client.chat.completions.create({
      model: this.#model,
      messages: [
        { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
        { role: "user", content: renderMessage(message, identity) },
      ],
      tools: [{ type: "function", function: { name: LOOP_TOOL_NAME, parameters: LOOP_TOOL_PARAMETERS } }],
      tool_choice: { type: "function", function: { name: LOOP_TOOL_NAME } },
    });
    // Minimal shape cast keeps us off the SDK's evolving tool-call union without using `any`.
    const calls = response.choices[0]?.message.tool_calls as ReadonlyArray<{ function?: { arguments?: string } }> | undefined;
    return loopsFromToolArguments(calls?.[0]?.function?.arguments);
  }
}
