# CLAUDE.md

## Project Overview

TEOB-TS is a TypeScript event-sourcing/CQRS framework — a port of the Scala TEOB framework. It provides type-safe, composable abstractions for building event-sourced entities with multiple runtime backends.

## Build & Test Commands

This repo uses **pnpm** (see `packageManager` in package.json). New native/build-script
dependencies must be approved in `allowBuilds` (pnpm-workspace.yaml) or their install
scripts are skipped.

```bash
pnpm install                   # Install dependencies
pnpm run build                 # Compile TypeScript
pnpm test                      # Run all tests
pnpm exec vitest run test/petrinet.test.ts  # Run a single test file
pnpm exec tsc --noEmit         # Type check without emitting
```

**PostgreSQL tests** (require running Postgres):
```bash
docker compose up -d           # Start Postgres locally
pnpm test                      # Postgres tests auto-detect connection
```

## Module Structure

```
src/
├── core/                 # Base abstractions (Aggregate, Effect, EffectControl, Codec, types)
├── inmem/                # In-memory runtime (testing/dev)
├── sqlite/               # SQLite persistence (zero-config, WAL mode)
├── postgres/             # PostgreSQL persistence (async, LISTEN/NOTIFY)
├── service/              # Service lifecycle (ServiceTemplate, health checks, probe server)
├── http/                 # Auto-generated REST routes, OpenAPI schema
├── projection/           # Declarative read model projections with rebuild
├── saga/                 # Event-driven sagas (stateless + stateful with compensation)
├── telemetry/            # OpenTelemetry integration (spans, metrics, instrumented runtime)
├── quickstart/           # Zero-config starter API
├── petrinet/             # Petri Net flow modeling (FlowSchema, flowAggregate)
├── ai/                   # AI agent integration
│   ├── llm/              #   LLM service (OpenAI, OpenRouter), streaming, cost tracking, spend guard
│   ├── embedding/        #   Vector embeddings
│   ├── tool/             #   MCP tool registry with permission model
│   │   └── mcp/          #   MCP client (stdio + HTTP/SSE transports)
│   ├── knowledge/        #   RAG knowledge search (pgvector)
│   ├── memory/           #   Cross-session agent memory
│   ├── agent-flow/       #   Crash-resilient LLM agent aggregate
│   ├── guardrail/        #   Content safety policies (keyword, regex, length, LLM-as-judge)
│   ├── eval/             #   Evaluation framework (7 evaluators + dataset runner)
│   ├── prompt/           #   Versioned prompt registry with {{variable}} templates
│   ├── data/             #   Tabular data store + DataTool
│   ├── file/             #   File store + FileTool (CSV/JSON/markdown)
│   └── skill/            #   Skill definitions (SKILL.md parser, two-tier delivery)
├── testing/              # AggregateTestKit
└── cli/                  # Code scaffolding (teob new aggregate/projection/flow)
```

## Code Style

- TypeScript 5.7+ with strict mode
- ES modules (`"type": "module"`)
- Target ES2023
- Vitest for testing
