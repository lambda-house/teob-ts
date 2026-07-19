import type { MCPTool, MCPToolDefinition, MCPToolResult } from "../tool/types.js";
import { MCPToolResult as MCPToolResultFactory } from "../tool/types.js";
import type { NodeFlowDef } from "./def.js";
import type { NodeFlowState } from "./aggregate.js";
import type { Capability } from "../capability/types.js";

export interface SelfInspectToolOpts {
  agentId: string;
  flows: () => Promise<NodeFlowDef[]>;
  tools: () => Promise<MCPToolDefinition[]>;
  state: () => Promise<NodeFlowState>;
  capabilities?: () => Promise<Capability[]>;
}

/**
 * Auto-registered MCP tool that lets the LLM query its own runtime context.
 *
 * Input: `{ query: 'tools' | 'flows' | 'state' | 'attributes' | 'capabilities' }`.
 */
export function createSelfInspectTool(opts: SelfInspectToolOpts): MCPTool {
  return {
    name: "self_inspect",
    description:
      "Query the agent's runtime: available tools, flows, current attributes/state, or learned capabilities.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          enum: ["tools", "flows", "state", "attributes", "capabilities"],
        },
      },
      required: ["query"],
    },
    async execute(input: unknown): Promise<MCPToolResult> {
      const query = (input as { query?: string } | null)?.query;
      switch (query) {
        case "tools": {
          const tools = await opts.tools();
          return MCPToolResultFactory.success({
            agentId: opts.agentId,
            tools: tools.map((t) => ({ name: t.name, description: t.description })),
          });
        }
        case "flows": {
          const flows = await opts.flows();
          return MCPToolResultFactory.success({
            agentId: opts.agentId,
            flows: flows.map((f) => ({
              id: f.id,
              description: f.description,
              tags: [...f.tags],
              triggerKind: f.trigger.kind,
              nodeCount: f.nodes.size,
            })),
          });
        }
        case "state": {
          const state = await opts.state();
          return MCPToolResultFactory.success({
            agentId: opts.agentId,
            status: state.status,
            flowDefId: state.flowDefId,
            activeNodes: state.activeNodeCount,
            waitingNodes: [...state.waitingNodes],
            nodeStatuses: Object.fromEntries(state.nodeStatuses),
          });
        }
        case "attributes": {
          const state = await opts.state();
          return MCPToolResultFactory.success({
            agentId: opts.agentId,
            attributes: state.context,
          });
        }
        case "capabilities": {
          if (!opts.capabilities) {
            return MCPToolResultFactory.success({ agentId: opts.agentId, capabilities: [] });
          }
          const caps = await opts.capabilities();
          return MCPToolResultFactory.success({
            agentId: opts.agentId,
            capabilities: caps.map((c) => ({
              id: c.id,
              name: c.name,
              layer: c.layer,
              maturity: c.maturity,
              content: c.content,
            })),
          });
        }
        default:
          return MCPToolResultFactory.failure(
            `unknown query "${query}". Supported: tools, flows, state, attributes, capabilities.`,
          );
      }
    },
  };
}
