import type { ServerConfig } from "../server/config.ts";
import type { ExtractionClient } from "../extractor.ts";
import { AnthropicExtractionClient } from "../extractor.ts";
import { OpenAIExtractionClient } from "../openai-extractor.ts";
import type { DraftClient } from "../draft/draft-composer.ts";
import { AnthropicDraftClient, OpenAIDraftClient } from "../draft/draft-composer.ts";

/** True when the selected provider's API key is present. */
export function extractionConfigured(config: ServerConfig): boolean {
  return config.llmProvider === "openai" ? config.openaiApiKey !== null : config.anthropicApiKey !== null;
}

/** Short status string for /healthz. */
export function extractionStatus(config: ServerConfig): string {
  if (extractionConfigured(config)) return `configured (${config.llmProvider})`;
  return config.llmProvider === "openai" ? "missing OPENAI_API_KEY" : "missing ANTHROPIC_API_KEY";
}

export function buildExtractionClient(config: ServerConfig): ExtractionClient {
  if (config.llmProvider === "openai") {
    if (!config.openaiApiKey) throw new Error("OPENAI_API_KEY not set — extraction unavailable");
    return new OpenAIExtractionClient({ apiKey: config.openaiApiKey, model: config.openaiModel });
  }
  if (!config.anthropicApiKey) throw new Error("ANTHROPIC_API_KEY not set — extraction unavailable");
  return new AnthropicExtractionClient({ apiKey: config.anthropicApiKey });
}

export function buildDraftClient(config: ServerConfig): DraftClient {
  if (config.llmProvider === "openai") {
    if (!config.openaiApiKey) throw new Error("OPENAI_API_KEY not set — drafts unavailable");
    return new OpenAIDraftClient({ apiKey: config.openaiApiKey, model: config.openaiModel });
  }
  if (!config.anthropicApiKey) throw new Error("ANTHROPIC_API_KEY not set — drafts unavailable");
  return new AnthropicDraftClient({ apiKey: config.anthropicApiKey });
}
