import type { MCPToolResult } from "../tool/types.js";
import type { AgentOutcome } from "./types.js";

export type ToolSimulation = (args: unknown) => MCPToolResult | Promise<MCPToolResult>;

export interface NamedCheck {
  name: string;
  check: (state: unknown) => boolean;
}

export interface ExpectedOutcome {
  finalStatePredicate?: (state: unknown) => boolean;
  outcomeCode?: AgentOutcome;
  mustUseTools?: Set<string>;
  mustNotUseTools?: Set<string>;
  maxLLMCalls?: number;
  maxTokens?: number;
  customChecks?: NamedCheck[];
}

export interface Scenario {
  id: string;
  name: string;
  instruction: string;
  toolSimulations?: Map<string, ToolSimulation>;
  expectedOutcome?: ExpectedOutcome;
  tags?: Set<string>;
}
