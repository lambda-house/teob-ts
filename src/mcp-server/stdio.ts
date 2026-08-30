// stdio.ts — newline-delimited JSON-RPC over a pair of streams.
//
// The iron rule of this transport: NOTHING may be written to the output stream
// except MCP frames. This module is the only writer; the consumer's job is to
// route every diagnostic in the process to stderr. One stray console.log on
// stdout corrupts the stream, and the failure is silent.
//
// Frames are processed strictly in order (a promise chain, not a fan-out), so
// responses cannot interleave mid-write. stdin EOF is the graceful-shutdown
// signal and resolves the returned promise once in-flight work has drained.
import { createInterface } from "node:readline";
import { errorResponse, PARSE_ERROR } from "../mcp/errors.js";
import type { MCPServer } from "./dispatch.js";

export interface StdioStreams {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}

export function serveStdio(
  server: MCPServer,
  streams: StdioStreams = { input: process.stdin, output: process.stdout },
): Promise<void> {
  const rl = createInterface({ input: streams.input });
  let chain: Promise<void> = Promise.resolve();

  const writeFrame = (frame: unknown): void => {
    streams.output.write(`${JSON.stringify(frame)}\n`);
  };

  const handleLine = async (line: string): Promise<void> => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let message: unknown;
    try {
      message = JSON.parse(trimmed);
    } catch {
      writeFrame(errorResponse(null, PARSE_ERROR, "Parse error"));
      return;
    }
    const response = await server.handle(message);
    if (response !== null) writeFrame(response);
  };

  return new Promise((resolve) => {
    rl.on("line", (line) => {
      chain = chain.then(() => handleLine(line));
    });
    rl.on("close", () => {
      void chain.then(resolve);
    });
  });
}
