import pg from "pg";
import type { PostgresConfig } from "./config.js";

/**
 * LISTEN consumer for PostgreSQL NOTIFY events.
 * Connects a dedicated client, subscribes to journal_events channel,
 * and calls the handler for each notification.
 *
 * Features:
 * - Silence detection with configurable threshold
 * - Automatic reconnect with cooldown
 * - Graceful shutdown
 */
export interface ListenConsumer {
  /** Start listening. Resolves once the initial LISTEN is set up. */
  start(): Promise<void>;
  /** Stop listening and close the dedicated connection. */
  stop(): Promise<void>;
}

export interface ListenConfig {
  /** Duration of silence (ms) before triggering reconnection. Default 5000. */
  silenceThresholdMs?: number;
  /** Minimum time (ms) between reconnection attempts. Default 10000. */
  reconnectCooldownMs?: number;
  /** Delay (ms) before reconnecting after a failure. Default 5000. */
  reconnectDelayMs?: number;
}

export function createListenConsumer(
  pgConfig: PostgresConfig,
  onNotification: (ordering: number) => void,
  opts: ListenConfig = {},
): ListenConsumer {
  const silenceThresholdMs = opts.silenceThresholdMs ?? 5000;
  const reconnectCooldownMs = opts.reconnectCooldownMs ?? 10000;
  const reconnectDelayMs = opts.reconnectDelayMs ?? 5000;

  let client: pg.Client | undefined;
  let disposed = false;
  let silenceTimer: ReturnType<typeof setTimeout> | undefined;
  let lastActivity = Date.now();
  let reconnecting = false;

  function resetSilenceTimer() {
    if (silenceTimer) clearTimeout(silenceTimer);
    if (disposed) return;
    lastActivity = Date.now();
    silenceTimer = setTimeout(() => {
      if (!disposed && !reconnecting) {
        console.warn("[LISTEN] Silence threshold exceeded, reconnecting...");
        reconnect();
      }
    }, silenceThresholdMs);
    if (silenceTimer.unref) silenceTimer.unref();
  }

  async function connect(): Promise<void> {
    client = new pg.Client({
      host: pgConfig.host,
      port: pgConfig.port,
      database: pgConfig.database,
      user: pgConfig.user,
      password: pgConfig.password,
      application_name: `${pgConfig.applicationName ?? "teob"}-listen`,
    });

    client.on("notification", (msg) => {
      resetSilenceTimer();
      if (msg.channel === "journal_events" && msg.payload) {
        const ordering = Number(msg.payload);
        if (!isNaN(ordering)) {
          onNotification(ordering);
        }
      }
    });

    client.on("error", (err) => {
      if (!disposed) {
        console.error("[LISTEN] Connection error:", err.message);
        reconnect();
      }
    });

    client.on("end", () => {
      if (!disposed && !reconnecting) {
        console.warn("[LISTEN] Connection ended unexpectedly, reconnecting...");
        reconnect();
      }
    });

    await client.connect();
    await client.query("LISTEN journal_events");
    resetSilenceTimer();
  }

  async function reconnect(): Promise<void> {
    if (disposed || reconnecting) return;
    reconnecting = true;

    const elapsed = Date.now() - lastActivity;
    const waitMs = Math.max(0, reconnectCooldownMs - elapsed);

    try {
      if (client) {
        try {
          await client.end();
        } catch {
          // ignore close errors during reconnect
        }
        client = undefined;
      }

      if (waitMs > 0) {
        await new Promise((r) => setTimeout(r, waitMs));
      }

      if (!disposed) {
        await new Promise((r) => setTimeout(r, reconnectDelayMs));
        if (!disposed) {
          await connect();
          console.info("[LISTEN] Reconnected successfully");
        }
      }
    } catch (err) {
      if (!disposed) {
        console.error("[LISTEN] Reconnect failed:", (err as Error).message);
        // Will retry on next silence timeout
      }
    } finally {
      reconnecting = false;
    }
  }

  return {
    async start() {
      await connect();
    },

    async stop() {
      disposed = true;
      if (silenceTimer) clearTimeout(silenceTimer);
      if (client) {
        try {
          await client.end();
        } catch {
          // ignore errors during shutdown
        }
        client = undefined;
      }
    },
  };
}
