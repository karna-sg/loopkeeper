import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/server/config.ts";
import { buildExtractionClient, buildDraftClient, extractionConfigured, extractionStatus } from "../../src/llm/factory.ts";
import { OpenAIExtractionClient } from "../../src/openai-extractor.ts";
import { AnthropicExtractionClient } from "../../src/extractor.ts";
import { OpenAIDraftClient, AnthropicDraftClient } from "../../src/draft/draft-composer.ts";

function cfg(env: Record<string, string>) {
  return loadConfig(env as NodeJS.ProcessEnv);
}

describe("LLM provider factory", () => {
  it("auto-selects OpenAI when only an OpenAI key is set", () => {
    const config = cfg({ OPENAI_API_KEY: "sk-test" });
    expect(config.llmProvider).toBe("openai");
    expect(extractionConfigured(config)).toBe(true);
    expect(buildExtractionClient(config)).toBeInstanceOf(OpenAIExtractionClient);
    expect(buildDraftClient(config)).toBeInstanceOf(OpenAIDraftClient);
  });

  it("uses Anthropic when its key is set", () => {
    const config = cfg({ ANTHROPIC_API_KEY: "sk-ant-test" });
    expect(config.llmProvider).toBe("anthropic");
    expect(buildExtractionClient(config)).toBeInstanceOf(AnthropicExtractionClient);
    expect(buildDraftClient(config)).toBeInstanceOf(AnthropicDraftClient);
  });

  it("honours an explicit LLM_PROVIDER over auto-selection", () => {
    expect(cfg({ LLM_PROVIDER: "openai", ANTHROPIC_API_KEY: "sk-ant" }).llmProvider).toBe("openai");
  });

  it("reports + throws when the selected provider has no key", () => {
    const config = cfg({ LLM_PROVIDER: "openai" });
    expect(extractionConfigured(config)).toBe(false);
    expect(extractionStatus(config)).toContain("OPENAI_API_KEY");
    expect(() => buildExtractionClient(config)).toThrow(/OPENAI_API_KEY/);
    expect(() => buildDraftClient(config)).toThrow(/OPENAI_API_KEY/);
  });
});
