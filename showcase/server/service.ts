/**
 * Showcase service — wires all domains and AI into a ServiceTemplate.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import type { ServiceTemplate, ComponentExports } from "../../src/service/service-template.js";
import type { EntityRuntime } from "../../src/core/runtime.js";
import type { LLMService } from "../../src/ai/llm/llm-service.js";
import type { MCPToolRegistry } from "../../src/ai/tool/mcp-tool-registry.js";
import type { KnowledgeAPI } from "../../src/ai/knowledge/knowledge-api.js";
import { createOpenAILLMService } from "../../src/ai/llm/openai-llm-service.js";
import { createOpenRouterLLMService } from "../../src/ai/llm/openrouter-llm-service.js";
import { createMCPToolRegistry } from "../../src/ai/tool/mcp-tool-registry.js";
import { createKnowledgeSearchTool } from "../../src/ai/knowledge/knowledge-search-tool.js";
import { createInMemoryRuntime, registration } from "../../src/inmem/runtime.js";
import { tagCodec, objectCodec } from "../../src/core/codec.js";

import { giftCardAggregate, giftCardEventCodec, giftCardStateCodec } from "./domains/gift-card/aggregate.js";
import { todoAggregate, todoEventCodec, todoStateCodec } from "./domains/todo/aggregate.js";
import { signupFlowAggregate } from "./domains/signup/flow.js";
import { giftCardRoutes } from "./domains/gift-card/routes.js";
import { todoRoutes } from "./domains/todo/routes.js";
import { signupRoutes } from "./domains/signup/routes.js";
import { chatRoutes } from "./ai/routes.js";
import { createGiftCardBalanceTool, createTodoListTool } from "./ai/entity-tools.js";
import { createChatService, type ChatService } from "./ai/chat-service.js";
import { createInMemoryKnowledgeAPI, seedKnowledge } from "./ai/in-memory-knowledge.js";

// --- Layer types ---

interface Infra {}

interface Outside {
  llmService?: LLMService;
  toolRegistry: MCPToolRegistry;
  knowledgeAPI: KnowledgeAPI;
}

interface Entities {
  runtime: EntityRuntime;
}

interface Context {
  chatService?: ChatService;
}

// --- Template ---

export const showcaseTemplate: ServiceTemplate<Infra, Outside, Entities, Context> = {
  config: {
    probeServer: { host: "0.0.0.0", port: 9095 },
    httpServer: { host: "0.0.0.0", port: Number(process.env.PORT ?? 3000) },
  },

  async infra() {
    return {};
  },

  async outside(_infra) {
    // Try OpenRouter first, then OpenAI
    const openRouterKey = process.env.OPENROUTER_API_KEY;
    const openAIKey = process.env.OPENAI_API_KEY;
    let llmService: LLMService | undefined;

    if (openRouterKey) {
      llmService = createOpenRouterLLMService({ apiKey: openRouterKey });
      console.log("[showcase] AI enabled via OpenRouter");
    } else if (openAIKey) {
      llmService = createOpenAILLMService({ apiKey: openAIKey });
      console.log("[showcase] AI enabled via OpenAI");
    } else {
      console.log("[showcase] AI disabled — set OPENAI_API_KEY or OPENROUTER_API_KEY to enable");
    }

    const toolRegistry = createMCPToolRegistry();
    const knowledgeAPI = createInMemoryKnowledgeAPI();
    await seedKnowledge(knowledgeAPI);

    return { llmService, toolRegistry, knowledgeAPI };
  },

  async entities(_infra, outside) {
    const takenEmails = new Set<string>();

    const signupAgg = signupFlowAggregate({
      isEmailAvailable: async (email) => !takenEmails.has(email),
      createAccount: async (email, _password) => {
        takenEmails.add(email);
        return crypto.randomUUID();
      },
    });

    const { runtime } = createInMemoryRuntime([
      registration(giftCardAggregate, giftCardEventCodec, giftCardStateCodec),
      registration(todoAggregate, todoEventCodec, todoStateCodec),
      registration(signupAgg, tagCodec(), objectCodec("FlowState")),
    ]);

    // Register entity-aware AI tools
    outside.toolRegistry.register(createGiftCardBalanceTool(runtime));
    outside.toolRegistry.register(createTodoListTool(runtime));
    outside.toolRegistry.register(
      createKnowledgeSearchTool(outside.knowledgeAPI, [
        { name: "framework-docs", description: "TEOB-TS framework documentation" },
        { name: "faq", description: "Frequently asked questions about the showcase" },
      ]),
    );

    await runtime.start();
    return { runtime };
  },

  async context(_infra, outside, _entities) {
    const chatService = outside.llmService
      ? createChatService(outside.llmService, outside.toolRegistry)
      : undefined;
    return { chatService };
  },

  componentExports(_infra, outside, entities, context): ComponentExports {
    const app = new Hono();

    // Middleware
    app.use("/*", cors({ origin: "*" }));

    // Domain routes
    app.route("/api", giftCardRoutes(entities.runtime));
    app.route("/api", todoRoutes(entities.runtime));
    app.route("/api", signupRoutes(entities.runtime));

    // AI routes (if available)
    if (context.chatService) {
      app.route("/api", chatRoutes(context.chatService));
    } else {
      // Stub endpoints when AI is not configured
      app.all("/api/chat/*", (c) =>
        c.json(
          { error: "AI not configured. Set OPENAI_API_KEY or OPENROUTER_API_KEY." },
          501,
        ),
      );
    }

    // Describe endpoint
    app.get("/api/describe", (c) =>
      c.json({
        aggregates: [
          { category: "gift-card", commands: ["Issue", "Redeem", "Cancel", "GetBalance"] },
          { category: "todo", commands: ["AddItem", "CompleteItem", "UncompleteItem", "RemoveItem", "GetList"] },
          { category: "signup-flow", commands: ["InboundToken", "GetFlowInstanceView"] },
        ],
        aiEnabled: !!context.chatService,
      }),
    );

    return { healthChecks: [], routes: app };
  },

  async teardownEntities(entities) {
    await entities.runtime.shutdown();
  },
};
