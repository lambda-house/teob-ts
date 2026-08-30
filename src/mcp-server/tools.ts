// tools.ts — MCPToolRegistry → tools/list and tools/call, era-neutral.
// Dispatch wraps these into the modern { resultType: "complete" } envelope or
// the bare legacy shapes.
//
// The two error channels matter and are easy to get backwards:
//   - unknown (or hidden) tool, malformed params  → JSON-RPC error (-32602)
//   - a tool that ran and failed                  → isError: true in the RESULT
// The second one is what lets the model read the failure and self-correct.
import type { MCPToolRegistry } from "../ai/tool/mcp-tool-registry.js";
import type { MCPTool } from "../ai/tool/types.js";
import { INVALID_PARAMS } from "../mcp/errors.js";
import type { TextContentBlock, WireToolDef } from "../mcp/protocol.js";

/**
 * Tools exposed over the wire. Confirm/ConfirmIf tools are excluded: no MCP
 * transport here carries a confirmation step yet (MRTR/elicitation is M2), and
 * silently auto-executing a Confirm tool is the unsafe failure. Fail closed.
 */
export function visibleTools(registry: MCPToolRegistry): MCPTool[] {
  return registry
    .list()
    .filter((tool) => (tool.permission?.tag ?? "Auto") === "Auto")
    .sort((a, b) => a.name.localeCompare(b.name)); // deterministic order — cacheable
}

export function wireToolDefs(registry: MCPToolRegistry): WireToolDef[] {
  return visibleTools(registry).map((tool) => ({
    name: tool.name,
    ...(tool.title !== undefined ? { title: tool.title } : {}),
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...(tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema } : {}),
  }));
}

export interface ToolCallOutcome {
  /** Set on protocol-level failure (unknown tool, malformed params). */
  protocolError?: { code: number; message: string };
  /** Set when the tool ran — including when it ran and failed. */
  result?: { content: TextContentBlock[]; structuredContent?: unknown; isError: boolean };
}

export async function executeToolCall(registry: MCPToolRegistry, params: unknown): Promise<ToolCallOutcome> {
  const p = typeof params === "object" && params !== null ? (params as Record<string, unknown>) : undefined;
  const name = p?.["name"];
  if (typeof name !== "string" || name.length === 0) {
    return { protocolError: { code: INVALID_PARAMS, message: "tools/call requires a string 'name'" } };
  }
  const args = p?.["arguments"] ?? {};
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return { protocolError: { code: INVALID_PARAMS, message: "'arguments' must be an object" } };
  }

  const tool = registry.get(name);
  // A non-Auto tool is invisible on this transport, and an invisible tool is an
  // unknown tool — not a tool failure.
  if (!tool || (tool.permission?.tag ?? "Auto") !== "Auto") {
    return { protocolError: { code: INVALID_PARAMS, message: `Unknown tool: ${name}` } };
  }

  try {
    const outcome = await tool.execute(args);
    if (outcome.success) {
      const structured =
        typeof outcome.output === "object" && outcome.output !== null ? outcome.output : undefined;
      return {
        result: {
          content: [{ type: "text", text: asText(outcome.output) }],
          ...(structured !== undefined ? { structuredContent: structured } : {}),
          isError: false,
        },
      };
    }
    return {
      result: {
        content: [{ type: "text", text: outcome.error ?? "tool failed" }],
        isError: true,
      },
    };
  } catch (e) {
    // A throwing tool is still a tool-execution failure, not a protocol error.
    return {
      result: {
        content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
        isError: true,
      },
    };
  }
}

function asText(output: unknown): string {
  if (typeof output === "string") return output;
  if (output === undefined) return "";
  return JSON.stringify(output);
}
