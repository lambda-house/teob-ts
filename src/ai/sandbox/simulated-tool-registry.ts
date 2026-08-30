import type {
  MCPTool,
  MCPToolCall,
  MCPToolDefinition,
  MCPToolResult,
} from "../tool/types.js";
import { MCPToolResult as MCPToolResultFactory } from "../tool/types.js";
import type { MCPToolRegistry } from "../tool/mcp-tool-registry.js";
import type { Scenario, ToolSimulation } from "./scenario.js";

/**
 * Tool registry backed by pure functions. The agent calls tools as normal;
 * each call dispatches to its corresponding simulation.
 *
 * Errors thrown inside a simulation are wrapped as MCPToolResult.failure
 * rather than rejected — this matches Scala semantics where simulations
 * are expected to produce a definitive yes/no answer.
 */
export class SimulatedToolRegistry implements MCPToolRegistry {
  constructor(private readonly sims: Map<string, ToolSimulation>) {}

  static fromScenario(s: Scenario): SimulatedToolRegistry {
    return new SimulatedToolRegistry(s.toolSimulations ?? new Map());
  }

  static fromSimulations(sims: Map<string, ToolSimulation>): SimulatedToolRegistry {
    return new SimulatedToolRegistry(new Map(sims));
  }

  register(_tool: MCPTool): void {
    // no-op: simulations are externally managed.
  }

  get(_name: string): MCPTool | undefined {
    return undefined;
  }

  list(): MCPTool[] {
    return [];
  }

  getDefinitions(): MCPToolDefinition[] {
    return [...this.sims.keys()].map((name) => ({
      name,
      description: `Simulated tool ${name}`,
      inputSchema: { type: "object" },
    }));
  }

  async execute(call: MCPToolCall): Promise<MCPToolResult> {
    const sim = this.sims.get(call.name);
    if (!sim) return MCPToolResultFactory.failure(`Tool not simulated: ${call.name}`);
    try {
      return await sim(call.arguments);
    } catch (err) {
      return MCPToolResultFactory.failure(`Simulation error: ${String(err)}`);
    }
  }

  async executeAll(calls: MCPToolCall[]): Promise<Array<[MCPToolCall, MCPToolResult]>> {
    const out: Array<[MCPToolCall, MCPToolResult]> = [];
    for (const c of calls) out.push([c, await this.execute(c)]);
    return out;
  }
}
