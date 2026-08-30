// dispatch.ts — the transport-agnostic MCP server: one inbound message in,
// zero-or-one outbound message out. stdio writes the response as a frame; HTTP
// turns null into 202. Era is decided per request (modern requests carry
// io.modelcontextprotocol/protocolVersion in _meta; initialize selects legacy)
// — there is no connection state, because the 2026-07-28 spec removed it.
import type { MCPToolRegistry } from "../ai/tool/mcp-tool-registry.js";
import {
  errorResponse,
  INTERNAL_ERROR,
  INVALID_REQUEST,
  METHOD_NOT_FOUND,
  unsupportedVersionResponse,
} from "../mcp/errors.js";
import { requestedProtocolVersion } from "../mcp/meta.js";
import {
  type DiscoverResult,
  type JsonRpcId,
  type JsonRpcResponse,
  type MCPCapabilities,
  type MCPServerInfo,
  META_SERVER_INFO,
  MODERN_PROTOCOL_VERSION,
  type ModernToolCallResult,
  type ModernToolsListResult,
} from "../mcp/protocol.js";
import { isValidInputSchema } from "../mcp/schema.js";
import { initializeResult } from "./legacy.js";
import { executeToolCall, visibleTools, wireToolDefs } from "./tools.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface MCPServerOptions {
  registry: MCPToolRegistry;
  serverInfo: MCPServerInfo;
  /** Optional LLM-facing guidance, surfaced in discover/initialize results. */
  instructions?: string;
  /** Modern versions to advertise. Default: ["2026-07-28"]. */
  supportedVersions?: string[];
  /** Answer initialize-era clients too. Default: true. */
  legacyCompat?: boolean;
  /** Diagnostics sink. Route to stderr; never to stdout. */
  log?: (level: LogLevel, msg: string) => void;
}

export interface MCPServer {
  /** Never throws; never returns a value for a notification. */
  handle(message: unknown): Promise<JsonRpcResponse | null>;
  readonly capabilities: MCPCapabilities;
  readonly serverInfo: MCPServerInfo;
  readonly supportedVersions: string[];
}

export function createMCPServer(opts: MCPServerOptions): MCPServer {
  const supportedVersions = opts.supportedVersions ?? [MODERN_PROTOCOL_VERSION];
  const legacyCompat = opts.legacyCompat ?? true;
  const log = opts.log ?? (() => {});
  // v1 serves tools only, with no listChanged (subscriptions/listen is M2 —
  // declaring a capability the server does not honour would be a lie).
  const capabilities: MCPCapabilities = { tools: {} };

  // A bad inputSchema is a programming error in the consumer — fail at
  // construction, not on the first tools/list a real client sends.
  for (const tool of visibleTools(opts.registry)) {
    if (!isValidInputSchema(tool.inputSchema)) {
      throw new Error(`MCP tool "${tool.name}" has an invalid inputSchema: must be a JSON Schema object`);
    }
  }

  async function dispatch(message: unknown): Promise<JsonRpcResponse | null> {
    if (typeof message !== "object" || message === null || Array.isArray(message)) {
      return errorResponse(null, INVALID_REQUEST, "not a JSON-RPC message");
    }
    const msg = message as Record<string, unknown>;
    const id = msg["id"];
    const method = msg["method"];
    const isRequest = typeof id === "string" || typeof id === "number";

    if (msg["jsonrpc"] !== "2.0" || typeof method !== "string") {
      return isRequest ? errorResponse(id as JsonRpcId, INVALID_REQUEST, "invalid JSON-RPC request") : null;
    }

    if (!isRequest) {
      // Notifications get no response, valid or not. The two we expect:
      // notifications/initialized (legacy lifecycle), notifications/cancelled.
      log("debug", `notification: ${method}`);
      return null;
    }
    const requestId = id as JsonRpcId;
    const version = requestedProtocolVersion(msg);

    // Lenience: some legacy clients (this repo's own MCPClient included) send
    // notifications/* as requests with an id. Acknowledge instead of erroring.
    if (method.startsWith("notifications/")) {
      return result(requestId, {});
    }

    if (version !== null) {
      // Modern era.
      if (!supportedVersions.includes(version)) {
        return unsupportedVersionResponse(requestId, version, supportedVersions);
      }
      switch (method) {
        case "server/discover":
          return result(requestId, discoverResult());
        case "ping":
          return result(requestId, {});
        case "tools/list":
          return result(requestId, {
            resultType: "complete",
            tools: wireToolDefs(opts.registry),
          } satisfies ModernToolsListResult);
        case "tools/call": {
          const outcome = await executeToolCall(opts.registry, msg["params"]);
          if (outcome.protocolError || !outcome.result) {
            const err = outcome.protocolError ?? { code: INTERNAL_ERROR, message: "tool call produced no result" };
            return errorResponse(requestId, err.code, err.message);
          }
          return result(requestId, { resultType: "complete", ...outcome.result } satisfies ModernToolCallResult);
        }
        default:
          return errorResponse(requestId, METHOD_NOT_FOUND, `Method not found: ${method}`);
      }
    }

    // Legacy era (no _meta protocol version).
    if (method === "initialize") {
      if (!legacyCompat) {
        // Per spec: a modern-only server SHOULD name its supported versions in
        // any error to initialize — it is the only diagnostic a legacy client
        // can surface.
        return unsupportedVersionResponse(requestId, null, supportedVersions);
      }
      return result(requestId, initializeResult(opts.serverInfo, capabilities, msg["params"], opts.instructions));
    }
    if (method === "ping") return result(requestId, {});
    if (!legacyCompat) {
      return unsupportedVersionResponse(requestId, null, supportedVersions);
    }
    switch (method) {
      case "tools/list":
        // Legacy shape: no resultType envelope.
        return result(requestId, { tools: wireToolDefs(opts.registry) });
      case "tools/call": {
        const outcome = await executeToolCall(opts.registry, msg["params"]);
        if (outcome.protocolError) {
          return errorResponse(requestId, outcome.protocolError.code, outcome.protocolError.message);
        }
        return result(requestId, outcome.result);
      }
      default:
        return errorResponse(requestId, METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  }

  function discoverResult(): DiscoverResult {
    return {
      resultType: "complete",
      supportedVersions,
      capabilities,
      _meta: { [META_SERVER_INFO]: opts.serverInfo },
      ...(opts.instructions !== undefined ? { instructions: opts.instructions } : {}),
    };
  }

  return {
    capabilities,
    serverInfo: opts.serverInfo,
    supportedVersions,
    async handle(message: unknown): Promise<JsonRpcResponse | null> {
      try {
        return await dispatch(message);
      } catch (e) {
        // handle() must never throw: a transport cannot recover from that.
        log("error", `dispatch failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
        const id = typeof message === "object" && message !== null ? (message as Record<string, unknown>)["id"] : null;
        const requestId = typeof id === "string" || typeof id === "number" ? id : null;
        return requestId === null ? null : errorResponse(requestId, INTERNAL_ERROR, "internal error");
      }
    },
  };
}

function result(id: JsonRpcId, value: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result: value };
}
