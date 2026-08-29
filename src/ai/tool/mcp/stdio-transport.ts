import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { MCPRequest, MCPResponse } from "./protocol.js";
import type { MCPTransport } from "./transport.js";

/**
 * Stdio transport: spawns a child process and communicates via stdin/stdout
 * with line-based JSON-RPC messages.
 */
export function createStdioTransport(
  command: string,
  args: string[] = [],
  options?: { cwd?: string; env?: Record<string, string> },
): MCPTransport {
  let process: ChildProcess | undefined;
  const pending = new Map<number, { resolve: (r: MCPResponse) => void; reject: (e: Error) => void }>();

  function ensureProcess(): ChildProcess {
    if (process) return process;

    process = spawn(command, args, {
      cwd: options?.cwd,
      env: { ...globalThis.process.env, ...options?.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const rl = createInterface({ input: process.stdout! });
    rl.on("line", (line) => {
      try {
        const response = JSON.parse(line) as MCPResponse;
        if (response.id !== undefined) {
          const p = pending.get(response.id);
          if (p) {
            pending.delete(response.id);
            p.resolve(response);
          }
        }
      } catch {
        // skip non-JSON lines
      }
    });

    process.on("exit", () => {
      for (const [, p] of pending) {
        p.reject(new Error("MCP process exited"));
      }
      pending.clear();
      process = undefined;
    });

    return process;
  }

  return {
    async send(request: MCPRequest): Promise<MCPResponse> {
      const proc = ensureProcess();

      return new Promise((resolve, reject) => {
        pending.set(request.id, { resolve, reject });
        const data = JSON.stringify(request) + "\n";
        proc.stdin!.write(data, (err) => {
          if (err) {
            pending.delete(request.id);
            reject(err);
          }
        });
      });
    },

    async close(): Promise<void> {
      if (process) {
        process.kill();
        process = undefined;
      }
      for (const [, p] of pending) {
        p.reject(new Error("Transport closed"));
      }
      pending.clear();
    },
  };
}
