import type {
  MCPTool,
  MCPToolCall,
  MCPToolDefinition,
  MCPToolResult,
} from "../tool/types.js";
import type { MCPToolRegistry } from "../tool/mcp-tool-registry.js";
import type { RecordedToolExec } from "./types.js";

let nextCallId = 1;
function genCallId(): string {
  return `tc-${(nextCallId++).toString(36)}`;
}

export class RecordingToolRegistry implements MCPToolRegistry {
  private buffer: RecordedToolExec[] = [];

  constructor(
    private readonly underlying: MCPToolRegistry,
    private readonly clock: () => number = () => Date.now(),
    private readonly isoClock: () => string = () => new Date().toISOString(),
  ) {}

  async getRecordedExecs(): Promise<RecordedToolExec[]> {
    return [...this.buffer];
  }

  register(tool: MCPTool): void {
    this.underlying.register(tool);
  }

  get(name: string): MCPTool | undefined {
    return this.underlying.get(name);
  }

  list(): MCPTool[] {
    return this.underlying.list();
  }

  getDefinitions(): MCPToolDefinition[] {
    return this.underlying.getDefinitions();
  }

  async execute(call: MCPToolCall): Promise<MCPToolResult> {
    const t0 = this.clock();
    const result = await this.underlying.execute(call);
    const t1 = this.clock();
    this.buffer.push({
      type: "toolexec",
      toolCallId: genCallId(),
      toolName: call.name,
      arguments: call.arguments,
      result,
      latencyMs: t1 - t0,
      completedAt: this.isoClock(),
    });
    return result;
  }

  async executeAll(calls: MCPToolCall[]): Promise<Array<[MCPToolCall, MCPToolResult]>> {
    const out: Array<[MCPToolCall, MCPToolResult]> = [];
    for (const c of calls) {
      const r = await this.execute(c);
      out.push([c, r]);
    }
    return out;
  }
}
