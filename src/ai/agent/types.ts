// --- REST types ---

export interface SessionConfig {
  backend?: string;
  prompt?: string;
  systemPrompt?: string;
  model?: string;
  cwd?: string;
  allowedTools?: string[];
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan";
  maxTurns?: number;
  maxBudgetUsd?: number;
  providerID?: string;
  modelID?: string;
  serverUrl?: string;
}

export interface CreateSessionResponse {
  id: string;
  wsUrl: string;
}

export type SessionStatus = "pending" | "active" | "completed" | "error" | "terminated";

export interface SessionInfo {
  id: string;
  status: SessionStatus;
  startTime: string;
  durationMs: number;
  backendSessionId?: string;
}

export interface HealthResponse {
  status: string;
  activeSessions: number;
}

export interface BackendModelInfo {
  id: string;
  name: string;
  description?: string;
  providerID?: string;
  modelID?: string;
}

export interface BackendInfo {
  name: string;
  models: BackendModelInfo[];
  error?: string;
}

// --- WebSocket downstream messages (server → client) ---

export type WsDownstreamMessage =
  | { type: "system"; sessionId: string; model?: string }
  | { type: "assistant"; text: string }
  | { type: "tool_use"; toolName: string; input: unknown }
  | { type: "tool_result"; toolName: string; output: string }
  | { type: "result"; text: string; costUsd?: number; durationMs?: number; numTurns?: number }
  | { type: "error"; message: string }
  | { type: "closed"; reason: "completed" | "terminated" | "error" };

export function parseWsDownstreamMessage(data: string): WsDownstreamMessage {
  const json = JSON.parse(data) as Record<string, unknown>;
  const type = json.type as string;

  switch (type) {
    case "system":
      return { type: "system", sessionId: json.sessionId as string, model: json.model as string | undefined };
    case "assistant":
      return { type: "assistant", text: json.text as string };
    case "tool_use":
      return { type: "tool_use", toolName: json.toolName as string, input: json.input };
    case "tool_result":
      return { type: "tool_result", toolName: json.toolName as string, output: json.output as string };
    case "result":
      return {
        type: "result",
        text: json.text as string,
        costUsd: json.costUsd as number | undefined,
        durationMs: json.durationMs as number | undefined,
        numTurns: json.numTurns as number | undefined,
      };
    case "error":
      return { type: "error", message: json.message as string };
    case "closed":
      return { type: "closed", reason: json.reason as "completed" | "terminated" | "error" };
    default:
      throw new Error(`Unknown WsDownstreamMessage type: ${type}`);
  }
}

// --- WebSocket upstream messages (client → server) ---

export type WsUpstreamMessage =
  | { type: "user_message"; text: string }
  | { type: "interrupt" };

export function serializeWsUpstreamMessage(msg: WsUpstreamMessage): string {
  return JSON.stringify(msg);
}
