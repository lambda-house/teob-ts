import type { LLMService } from "./llm-service.js";
import { createOpenAILLMService, type OpenAILLMConfig } from "./openai-llm-service.js";

/**
 * OpenRouter-specific factory. Uses the OpenRouter API endpoint.
 *
 * OpenRouter provides a unified API for accessing multiple LLM providers
 * (Claude, GPT, Llama, etc.) through the OpenAI-compatible chat completions API.
 */
export function createOpenRouterLLMService(
  config: Omit<OpenAILLMConfig, "baseUrl"> & { model?: string },
): LLMService {
  return createOpenAILLMService({
    ...config,
    model: config.model ?? "anthropic/claude-sonnet-4",
    baseUrl: "https://openrouter.ai/api/v1/chat/completions",
  });
}
