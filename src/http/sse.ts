// sse.ts — Server-Sent Events stream: bus fan-out + framework-agnostic Response.
// No Hono imports here; handlers consume Web-standard Request/Response.

import type { PersistedBatch } from "../core/envelope.js";

/** Frames multiplexed over one SSE stream. */
export type StreamFrame =
  | { type: "hello"; startedAt: number; now: number }
  | {
      type: "journal";
      category: string;
      entityId: string;
      records: Array<{ sequenceNr: number; manifest: string; encoded: unknown; envelope: unknown }>;
      at: number;
    }
  | { type: "signal"; row: unknown /* SignalRow shape, src/ha/signal-store.ts */ };

/** In-process fan-out bus: publishers push frames, SSE subscribers receive them. */
export interface StreamBus {
  publish(frame: StreamFrame): void;
  subscribe(fn: (frame: StreamFrame) => void): () => void;
  subscriberCount(): number;
}

/** Create a StreamBus. Subscriber errors are swallowed — publish never throws. */
export function createStreamBus(): StreamBus {
  const subscribers = new Set<(frame: StreamFrame) => void>();
  return {
    publish(frame: StreamFrame): void {
      for (const fn of [...subscribers]) {
        try {
          fn(frame);
        } catch {
          // A broken subscriber must not break fan-out (publish runs inside the persist hook).
        }
      }
    },
    subscribe(fn: (frame: StreamFrame) => void): () => void {
      subscribers.add(fn);
      return () => {
        subscribers.delete(fn);
      };
    },
    subscriberCount(): number {
      return subscribers.size;
    },
  };
}

/** Adapter: PersistedBatch → journal frame. */
export function journalFrame(batch: PersistedBatch): StreamFrame {
  return {
    type: "journal",
    category: batch.category,
    entityId: batch.entityId,
    records: batch.records.map((r) => ({
      sequenceNr: r.sequenceNr,
      manifest: r.manifest,
      encoded: r.encoded,
      envelope: r.envelope,
    })),
    at: batch.at,
  };
}

export interface SseOptions {
  /** Keepalive comment cadence. Default 15_000. */
  keepaliveMs?: number;
  /** ms epoch reported in the hello frame. Default Date.now(). */
  startedAt?: number;
}

/** A subscriber whose unread queue exceeds this many bytes is considered stalled and dropped. */
const MAX_BUFFERED_BYTES = 1_048_576;

/**
 * Build a `text/event-stream` Response over a ReadableStream.
 *
 * Wire format per frame: `event: <frame.type>\n` + `data: <JSON of frame>\n\n`.
 * On open: `retry: 3000\n\n` then a hello frame. Every keepaliveMs: `: keepalive\n\n`.
 * Unsubscribes from the bus and stops the keepalive timer on stream cancel.
 *
 * Backpressure: a client socket that stalls without closing (sleeping tablet,
 * dropped Wi-Fi with no RST) stops the server-side pump reading, so frames pile
 * up in the ReadableStream queue. Once a subscriber is more than
 * MAX_BUFFERED_BYTES behind it is disconnected; EventSource auto-reconnects
 * (retry: 3000) with a fresh stream.
 */
export function sseResponse(bus: StreamBus, opts?: SseOptions): Response {
  const keepaliveMs = opts?.keepaliveMs ?? 15_000;
  const startedAt = opts?.startedAt ?? Date.now();
  const encoder = new TextEncoder();

  let unsubscribe: (() => void) | undefined;
  let keepalive: ReturnType<typeof setInterval> | undefined;

  function cleanup(): void {
    unsubscribe?.();
    unsubscribe = undefined;
    if (keepalive !== undefined) {
      clearInterval(keepalive);
      keepalive = undefined;
    }
  }

  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        const write = (text: string): void => {
          // desiredSize = highWaterMark - queued bytes; deeply negative means the
          // consumer stopped reading long ago — drop the client instead of
          // buffering its frames forever.
          if ((controller.desiredSize ?? 0) < -MAX_BUFFERED_BYTES) {
            cleanup();
            try {
              controller.close();
            } catch {
              // already closed/errored — nothing to do
            }
            return;
          }
          try {
            controller.enqueue(encoder.encode(text));
          } catch {
            // Consumer went away without a clean cancel — stop publishing to it.
            cleanup();
          }
        };
        const sendFrame = (frame: StreamFrame): void => {
          write(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`);
        };

        write("retry: 3000\n\n");
        sendFrame({ type: "hello", startedAt, now: Date.now() });
        unsubscribe = bus.subscribe(sendFrame);
        keepalive = setInterval(() => write(": keepalive\n\n"), keepaliveMs);
      },
      cancel() {
        cleanup();
      },
    },
    new ByteLengthQueuingStrategy({ highWaterMark: 65_536 }),
  );

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
