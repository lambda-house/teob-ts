// http.ts — Streamable HTTP (2026-07-28 shape): a single POST endpoint, no
// sessions, no GET stream, no resumability. Every response here is a plain
// application/json body — per spec the server chooses per request between JSON
// and a request-scoped SSE stream, and a tools-only server with no progress
// notifications has nothing to stream.
//
// The header rules exist so intermediaries can route on headers without
// parsing bodies, which is exactly why mismatches MUST be rejected: a proxy
// enforcing policy on Mcp-Name must never disagree with what the body executes.
import { Hono } from "hono";
import {
  errorResponse,
  HEADER_MISMATCH,
  INVALID_REQUEST,
  METHOD_NOT_FOUND,
  PARSE_ERROR,
  UNSUPPORTED_PROTOCOL_VERSION,
} from "../mcp/errors.js";
import { paramsOf, requestedProtocolVersion } from "../mcp/meta.js";
import type { JsonRpcId, JsonRpcResponse } from "../mcp/protocol.js";
import type { MCPServer } from "./dispatch.js";

export interface McpHttpOptions {
  /**
   * Origin allowlist (DNS-rebinding defence). A request with no Origin header
   * is always accepted — server-to-server MCP clients send none. A request
   * with an Origin is accepted only if listed here (or the predicate says so);
   * with no policy configured, any present Origin is rejected, which is the
   * safe default for a local server.
   */
  allowedOrigins?: string[] | ((origin: string) => boolean);
}

/** Mount with app.route("/mcp", mcpHono(server, opts)). */
export function mcpHono(server: MCPServer, opts: McpHttpOptions = {}): Hono {
  const app = new Hono();

  app.post("/", async (c) => {
    const origin = c.req.header("origin");
    if (origin !== undefined && !originAllowed(origin, opts.allowedOrigins)) {
      return c.json(errorResponse(null, INVALID_REQUEST, "Origin not allowed"), 403);
    }

    let message: unknown;
    try {
      message = JSON.parse(await c.req.text());
    } catch {
      return c.json(errorResponse(null, PARSE_ERROR, "Parse error"), 400);
    }

    const msg = typeof message === "object" && message !== null ? (message as Record<string, unknown>) : {};
    const rawId = msg["id"];
    const id: JsonRpcId | null = typeof rawId === "string" || typeof rawId === "number" ? rawId : null;

    // Header↔body validation applies to modern requests — the era that defines
    // the headers. Legacy bodies (initialize handshakes and friends) predate
    // them and are exempt.
    const version = requestedProtocolVersion(message);
    if (version !== null && id !== null) {
      const mismatch = validateHeaders(c.req.header.bind(c.req), msg, version);
      if (mismatch !== null) {
        return c.json(errorResponse(id, HEADER_MISMATCH, mismatch), 400);
      }
    }

    const response = await server.handle(message);
    if (response === null) {
      // Notification accepted: 202, no body.
      return c.body(null, 202);
    }
    return c.json(response, httpStatusFor(response));
  });

  // Legacy Streamable HTTP had GET streams and DELETE session teardown; this
  // revision has neither. 405 tells an old client exactly that.
  app.on(["GET", "DELETE", "PUT", "PATCH", "HEAD"], "/", (c) => c.body(null, 405));

  return app;
}

function validateHeaders(
  header: (name: string) => string | undefined,
  msg: Record<string, unknown>,
  bodyVersion: string,
): string | null {
  const headerVersion = header("mcp-protocol-version");
  if (headerVersion === undefined) return "missing MCP-Protocol-Version header";
  if (headerVersion !== bodyVersion) {
    return `MCP-Protocol-Version header '${headerVersion}' does not match body value '${bodyVersion}'`;
  }
  const method = msg["method"];
  const headerMethod = header("mcp-method");
  if (headerMethod === undefined) return "missing Mcp-Method header";
  if (headerMethod !== method) {
    return `Mcp-Method header '${headerMethod}' does not match body value '${String(method)}'`;
  }
  if (method === "tools/call" || method === "resources/read" || method === "prompts/get") {
    const bodyName = paramsOf(msg)?.[method === "resources/read" ? "uri" : "name"];
    const headerName = header("mcp-name");
    if (headerName === undefined) return "missing Mcp-Name header";
    if (decodeSentinel(headerName) !== bodyName) {
      return `Mcp-Name header '${headerName}' does not match body value '${String(bodyName)}'`;
    }
  }
  return null;
}

/** Base64 sentinel form: =?base64?<payload>?= (markers are case-sensitive). */
function decodeSentinel(value: string): string {
  if (value.startsWith("=?base64?") && value.endsWith("?=")) {
    return Buffer.from(value.slice(9, -2), "base64").toString("utf8");
  }
  return value;
}

function httpStatusFor(response: JsonRpcResponse): 200 | 400 | 404 | 500 {
  const code = response.error?.code;
  if (code === undefined) return 200;
  switch (code) {
    case METHOD_NOT_FOUND:
      return 404; // distinguishes a modern server from a legacy HTTP+SSE one
    case UNSUPPORTED_PROTOCOL_VERSION:
    case HEADER_MISMATCH:
    case PARSE_ERROR:
    case INVALID_REQUEST:
      return 400;
    default:
      return 200; // e.g. -32602 unknown tool: a JSON-RPC-level error, not an HTTP one
  }
}

function originAllowed(origin: string, policy: McpHttpOptions["allowedOrigins"]): boolean {
  if (policy === undefined) return false;
  if (typeof policy === "function") return policy(origin);
  return policy.includes(origin);
}
