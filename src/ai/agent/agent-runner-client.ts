import type {
  BackendInfo,
  CreateSessionResponse,
  HealthResponse,
  SessionConfig,
  SessionInfo,
  WsDownstreamMessage,
} from "./types.js";
import { parseWsDownstreamMessage } from "./types.js";

/** A connected WebSocket agent session. */
export interface AgentSession {
  /** Async iterable of downstream messages from the agent. */
  messages: AsyncIterable<WsDownstreamMessage>;
  /** Send a user message to the agent. */
  sendMessage(text: string): void;
  /** Interrupt the running agent. */
  interrupt(): void;
  /** Close the WebSocket connection. */
  close(): void;
}

/** Client for the Claude Agent Runner REST + WebSocket API. */
export interface AgentRunnerClient {
  health(): Promise<HealthResponse>;
  listBackends(): Promise<BackendInfo[]>;
  listSessions(): Promise<SessionInfo[]>;
  createSession(config: SessionConfig): Promise<CreateSessionResponse>;
  deleteSession(id: string): Promise<boolean>;
  connectSession(sessionId: string): Promise<AgentSession>;
}

/**
 * Create an AgentRunnerClient using fetch + WebSocket.
 *
 * @param baseUrl - Base URL of the agent runner (e.g. "http://localhost:3100")
 */
export function createAgentRunnerClient(baseUrl: string): AgentRunnerClient {
  async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`, init);
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Agent Runner API error ${response.status}: ${body}`);
    }
    return response.json() as Promise<T>;
  }

  function wsUrl(sessionId: string): string {
    const url = new URL(baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = `/ws/${sessionId}`;
    return url.toString();
  }

  return {
    health() {
      return fetchJson<HealthResponse>("/health");
    },

    listBackends() {
      return fetchJson<BackendInfo[]>("/api/backends");
    },

    listSessions() {
      return fetchJson<SessionInfo[]>("/api/sessions");
    },

    createSession(config) {
      return fetchJson<CreateSessionResponse>("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
    },

    async deleteSession(id) {
      const response = await fetch(`${baseUrl}/api/sessions/${id}`, { method: "DELETE" });
      return response.ok;
    },

    connectSession(sessionId) {
      return new Promise<AgentSession>((resolve, reject) => {
        const ws = new WebSocket(wsUrl(sessionId));
        const messageQueue: WsDownstreamMessage[] = [];
        let waitingResolve: ((value: IteratorResult<WsDownstreamMessage>) => void) | null = null;
        let closed = false;

        ws.addEventListener("message", (event) => {
          try {
            const msg = parseWsDownstreamMessage(event.data as string);
            if (waitingResolve) {
              const resolve = waitingResolve;
              waitingResolve = null;
              resolve({ value: msg, done: false });
            } else {
              messageQueue.push(msg);
            }
          } catch {
            // Skip unparseable messages
          }
        });

        ws.addEventListener("close", () => {
          closed = true;
          if (waitingResolve) {
            const resolve = waitingResolve;
            waitingResolve = null;
            resolve({ value: undefined as unknown as WsDownstreamMessage, done: true });
          }
        });

        ws.addEventListener("error", (event) => {
          if (!closed) {
            reject(new Error(`WebSocket error: ${String(event)}`));
          }
        });

        ws.addEventListener("open", () => {
          const messages: AsyncIterable<WsDownstreamMessage> = {
            [Symbol.asyncIterator]() {
              return {
                next(): Promise<IteratorResult<WsDownstreamMessage>> {
                  if (messageQueue.length > 0) {
                    return Promise.resolve({ value: messageQueue.shift()!, done: false });
                  }
                  if (closed) {
                    return Promise.resolve({
                      value: undefined as unknown as WsDownstreamMessage,
                      done: true,
                    });
                  }
                  return new Promise((resolve) => {
                    waitingResolve = resolve;
                  });
                },
              };
            },
          };

          resolve({
            messages,
            sendMessage(text: string) {
              ws.send(JSON.stringify({ type: "user_message", text }));
            },
            interrupt() {
              ws.send(JSON.stringify({ type: "interrupt" }));
            },
            close() {
              ws.close();
            },
          });
        });
      });
    },
  };
}
