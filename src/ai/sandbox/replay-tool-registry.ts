import type {
  MCPTool,
  MCPToolCall,
  MCPToolDefinition,
  MCPToolResult,
} from "../tool/types.js";
import type { MCPToolRegistry } from "../tool/mcp-tool-registry.js";
import type { AgentRunRecording, RecordedToolExec } from "./types.js";
import { RecordingExhaustedError } from "./errors.js";

/**
 * Tool registry that replays recorded tool execs in order. Ignores
 * `call.arguments` — returns the recorded result unconditionally.
 *
 * Tool definitions are derived from the distinct toolNames seen in the
 * recording.
 */
export class ReplayToolRegistry implements MCPToolRegistry {
  private cursor = 0;
  private definitions: MCPToolDefinition[];

  constructor(private readonly execs: RecordedToolExec[]) {
    const seen = new Set<string>();
    this.definitions = [];
    for (const e of execs) {
      if (seen.has(e.toolName)) continue;
      seen.add(e.toolName);
      this.definitions.push({
        name: e.toolName,
        description: `Replayed tool ${e.toolName}`,
        inputSchema: { type: "object" },
      });
    }
  }

  static from(rec: AgentRunRecording): ReplayToolRegistry {
    const execs = rec.steps.filter((s): s is RecordedToolExec => s.type === "toolexec");
    return new ReplayToolRegistry(execs);
  }

  static fromExecs(execs: RecordedToolExec[]): ReplayToolRegistry {
    return new ReplayToolRegistry([...execs]);
  }

  async served(): Promise<number> {
    return this.cursor;
  }

  register(_tool: MCPTool): void {
    // no-op: replay is a closed set.
  }

  get(_name: string): MCPTool | undefined {
    return undefined;
  }

  list(): MCPTool[] {
    return [];
  }

  getDefinitions(): MCPToolDefinition[] {
    return [...this.definitions];
  }

  async execute(_call: MCPToolCall): Promise<MCPToolResult> {
    if (this.cursor >= this.execs.length) {
      throw new RecordingExhaustedError(this.cursor + 1, this.execs.length, "tool");
    }
    return this.execs[this.cursor++].result;
  }

  async executeAll(calls: MCPToolCall[]): Promise<Array<[MCPToolCall, MCPToolResult]>> {
    const out: Array<[MCPToolCall, MCPToolResult]> = [];
    for (const c of calls) out.push([c, await this.execute(c)]);
    return out;
  }
}
