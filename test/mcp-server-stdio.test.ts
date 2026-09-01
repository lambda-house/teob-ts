import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createMCPToolRegistry } from "../src/ai/tool/mcp-tool-registry.js";
import { MCPToolResult } from "../src/ai/tool/types.js";
import { createMCPServer, serveStdio } from "../src/mcp-server/index.js";

function makeServer() {
  const registry = createMCPToolRegistry();
  registry.register({
    name: "noisy",
    description: "a tool whose author left a console.log in",
    inputSchema: { type: "object" },
    execute: () => {
      console.log("this must NOT reach the MCP stream");
      return Promise.resolve(MCPToolResult.success("ok"));
    },
  });
  return createMCPServer({ registry, serverInfo: { name: "stdio-test", version: "0.0.0" } });
}

interface Harness {
  input: PassThrough;
  frames: () => unknown[];
  raw: () => string;
  done: Promise<void>;
}

function harness(): Harness {
  const input = new PassThrough();
  const output = new PassThrough();
  let buffer = "";
  output.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
  });
  const done = serveStdio(makeServer(), { input, output });
  return {
    input,
    raw: () => buffer,
    frames: () =>
      buffer
        .split("\n")
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as unknown),
    done,
  };
}

const line = (msg: unknown) => `${JSON.stringify(msg)}\n`;

describe("stdio transport", () => {
  it("answers a request and exits on EOF", async () => {
    const h = harness();
    h.input.write(line({ jsonrpc: "2.0", id: 1, method: "ping" }));
    h.input.end();
    await h.done;
    expect(h.frames()).toEqual([{ jsonrpc: "2.0", id: 1, result: {} }]);
  });

  it("handles a message split across chunk boundaries", async () => {
    const h = harness();
    const msg = line({ jsonrpc: "2.0", id: 7, method: "tools/list" });
    h.input.write(msg.slice(0, 10));
    h.input.write(msg.slice(10, 25));
    h.input.write(msg.slice(25));
    h.input.end();
    await h.done;
    expect(h.frames()).toHaveLength(1);
    expect((h.frames()[0] as { id: number }).id).toBe(7);
  });

  it("handles several messages in one chunk, answered in order", async () => {
    const h = harness();
    h.input.write(
      line({ jsonrpc: "2.0", id: 1, method: "ping" }) +
        line({ jsonrpc: "2.0", method: "notifications/initialized" }) +
        line({ jsonrpc: "2.0", id: 2, method: "ping" }),
    );
    h.input.end();
    await h.done;
    expect(h.frames().map((f) => (f as { id: number }).id)).toEqual([1, 2]);
  });

  it("malformed JSON → -32700 with id null, stream stays alive", async () => {
    const h = harness();
    h.input.write("this is not json\n");
    h.input.write(line({ jsonrpc: "2.0", id: 3, method: "ping" }));
    h.input.end();
    await h.done;
    const frames = h.frames() as { id: number | null; error?: { code: number } }[];
    expect(frames[0]).toMatchObject({ id: null, error: { code: -32700 } });
    expect(frames[1]).toMatchObject({ id: 3 });
  });

  it("blank lines are ignored", async () => {
    const h = harness();
    h.input.write("\n  \n");
    h.input.write(line({ jsonrpc: "2.0", id: 4, method: "ping" }));
    h.input.end();
    await h.done;
    expect(h.frames()).toHaveLength(1);
  });

  it("stdout purity: a tool calling console.log does not corrupt the frame stream", async () => {
    // console.log writes to the real process.stdout, not our output stream —
    // the module's guarantee is that IT only ever writes frames. Every line of
    // output must parse as JSON-RPC.
    const h = harness();
    h.input.write(line({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "noisy", arguments: {} } }));
    h.input.end();
    await h.done;
    for (const rawLine of h.raw().split("\n").filter((l) => l.length > 0)) {
      const parsed = JSON.parse(rawLine) as { jsonrpc: string };
      expect(parsed.jsonrpc).toBe("2.0");
    }
    expect(h.frames()).toHaveLength(1);
  });
});
