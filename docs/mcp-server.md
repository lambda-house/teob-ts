# MCP Server

`teob-ts/mcp-server` serves an existing `MCPToolRegistry` as a Model Context
Protocol server, over stdio (local, e.g. Claude Code) and Streamable HTTP
(long-lived services). The shared wire types live in `teob-ts/mcp`; the client
under `src/ai/tool/mcp/` re-exports them, so client and server cannot drift.

Design notes and the phased roadmap: `MCP_SERVER_PLAN.md`. This module is M0+M1
of that plan: protocol core, dispatcher, stdio, legacy shim, Streamable HTTP,
`outputSchema`/`structuredContent`. No resources, prompts, sampling,
subscriptions or MRTR yet — tools only.

## Eras

The server is dual-era, decided per request (the 2026-07-28 revision removed
sessions, so era is not connection state):

- **Modern (`2026-07-28`)** — requests carry
  `params._meta["io.modelcontextprotocol/protocolVersion"]`; results use the
  `{ resultType: "complete" }` envelope; `server/discover` is served.
  Unsupported versions get `-32022` with the supported list.
- **Legacy (`2025-11-25` … `2024-11-05`)** — the `initialize` handshake and
  bare result shapes. On by default (`legacyCompat: true`) because measured
  clients still need it: Claude Code's v2 runtime negotiates 2026-07-28 over
  HTTP but speaks the legacy handshake to **stdio** servers unless the user
  sets `MCP_PROTOCOL_NEGOTIATION=auto`.

## Usage

```ts
import { createMCPToolRegistry } from "@lambda-house/teob-ts/ai";
import { createMCPServer, serveStdio, mcpHono } from "@lambda-house/teob-ts/mcp-server";

const registry = createMCPToolRegistry();
registry.register({ name: "hello", description: "...", inputSchema: { type: "object" },
  execute: async () => MCPToolResult.success({ hi: true }) });

const server = createMCPServer({
  registry,
  serverInfo: { name: "my-service", version: "1.0.0" },
  instructions: "Optional LLM-facing guidance.",
  log: (level, msg) => process.stderr.write(`[mcp:${level}] ${msg}\n`), // stderr, always
});

// stdio (register with: claude mcp add --transport stdio my-service -- node dist/main.js)
await serveStdio(server); // resolves on stdin EOF

// Streamable HTTP (single POST endpoint; GET/DELETE answer 405)
app.route("/mcp", mcpHono(server, { allowedOrigins: ["https://claude.ai"] }));
```

## Rules the module enforces

- **stdout purity (stdio):** the transport is the only writer to the output
  stream, and it writes nothing but newline-delimited JSON-RPC frames. Route
  every diagnostic in your process to stderr; one stray `console.log` on
  stdout corrupts the stream and the failure is silent.
- **Two error channels:** an unknown/hidden tool or malformed params is a
  JSON-RPC error (`-32602`); a tool that ran and failed (returned
  `MCPToolResult.failure` or threw) is `isError: true` *in the result*, so the
  model can read it and self-correct.
- **Confirm fails closed:** `ToolPermission.Confirm` / `ConfirmIf` tools are
  excluded from `tools/list` and answer like unknown tools. No transport here
  carries a confirmation step yet (MRTR is M2); silently auto-executing a
  confirm-gated tool would be the unsafe default.
- **`inputSchema` must be a JSON Schema object** — validated in
  `createMCPServer`, which throws at construction rather than failing on the
  first `tools/list`.
- **Caching hints on every cacheable modern result:** `server/discover` and
  `tools/list` carry `ttlMs` and `cacheScope`, which the 2026-07-28 revision
  makes a MUST — a strict client (Claude Code among them) rejects the result
  without them, and the server goes dark: connected, authenticated, zero tools.
  Default `{ ttlMs: 0, cacheScope: "public" }`; override with `cacheHints`.
  `tools/call` is not a cacheable operation and carries none, and the legacy
  era never sees them.
- **HTTP header validation:** modern POSTs must carry `MCP-Protocol-Version`
  (matching `_meta`), `Mcp-Method`, and `Mcp-Name` for `tools/call`; mismatch
  or absence is `400` + `-32020` (`HeaderMismatch`), with base64-sentinel
  values (`=?base64?…?=`) decoded before comparison. Unknown method is `404` +
  `-32601`; notifications get `202`; a present-but-unlisted `Origin` gets
  `403` (DNS-rebinding defence — server-to-server clients send no Origin).
- Responses are always `application/json`; a tools-only server with no
  progress notifications has nothing to stream over SSE. When SSE lands
  (subscriptions, M2), responses must set `X-Accel-Buffering: no` or reverse
  proxies buffer the stream.

## Tests

`test/mcp-server-{dispatch,stdio,http,loopback}.test.ts`. The loopback test
wires the repo's own legacy `MCPClient` to the server through an in-memory
transport — the pin that keeps both ends on one wire format.
