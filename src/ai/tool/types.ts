/** Result of an MCP tool execution. */
export interface MCPToolResult {
  success: boolean;
  output: unknown;
  error?: string;
}

export const MCPToolResult = {
  success: (output: unknown): MCPToolResult => ({ success: true, output }),
  failure: (error: string): MCPToolResult => ({ success: false, output: null, error }),
};

/** A request to call an MCP tool. */
export interface MCPToolCall {
  name: string;
  arguments: unknown;
}

/** Permission level for tool execution. */
export type ToolPermission =
  | { tag: "Auto" }
  | { tag: "Confirm" }
  | { tag: "ConfirmIf"; condition: string };

export const ToolPermission = {
  Auto: { tag: "Auto" } as ToolPermission,
  Confirm: { tag: "Confirm" } as ToolPermission,
  ConfirmIf: (condition: string): ToolPermission => ({ tag: "ConfirmIf", condition }),
} as const;

/** Callback invoked when a tool requires approval before execution. */
export type ToolApprovalCallback = (toolName: string, args: unknown) => Promise<boolean>;

/** Definition of an MCP tool that can be executed. */
export interface MCPTool {
  /** Unique name of the tool. */
  name: string;
  /** Human-readable description. */
  description: string;
  /** JSON Schema for the tool's input parameters. */
  inputSchema: unknown;
  /** Optional human-readable display name (MCP `title`). */
  title?: string;
  /** Optional JSON Schema for the tool's structured output (MCP `outputSchema`). */
  outputSchema?: unknown;
  /** Permission level governing when approval is required. Defaults to Auto. */
  permission?: ToolPermission;
  /** Execute the tool with the given arguments. */
  execute(input: unknown): Promise<MCPToolResult>;
}

/** Tool definition for inclusion in LLM context. */
export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: unknown;
}

export function toolDefinitionFromTool(tool: MCPTool): MCPToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  };
}
