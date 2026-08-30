// ha/client.ts — Home Assistant WebSocket client on the Node 22+ native WebSocket.
// Zero dependencies; the WebSocket constructor is injectable for tests.
//
// Responsibilities (M0 contract §3.2):
// - auth handshake (auth_required → auth → auth_ok / auth_invalid)
// - lazy subscribe_events per event type with registered handlers; re-armed on reconnect
// - subscribe_trigger with automatic re-arm after reconnect
// - full get_states snapshot after EVERY auth_ok (reason "initial" | "resync")
// - command multiplexing over per-connection message ids, timeouts, typed errors
// - reconnect with capped exponential backoff + jitter; app-level ping/pong liveness
// - recorder statistics commands with legacy has_mean → mean_type back-compat

import type {
  HaCallServiceEvent,
  HaCallServiceRequest,
  HaCallServiceResult,
  HaContext,
  HaEntityState,
  HaStateChangedEvent,
  HaStatesSnapshot,
  HaStatisticIdMeta,
  HaStatisticValue,
  HaStatisticsRequest,
} from "./types.js";
import { HaCommandError, HaDisconnectedError, HaTimeoutError } from "./types.js";

export interface HaClientOptions {
  url: string;    // ws://supervisor/core/websocket | ws://host:8123/api/websocket
  token: string;  // SUPERVISOR_TOKEN or long-lived token
  log?: (level: "debug" | "info" | "warn" | "error", msg: string) => void;
  backoff?: { initialMs?: number; maxMs?: number; jitterMs?: number }; // defaults 1_000 / 60_000 / 500
  /** App-level ping cadence; missed pong ⇒ force-close ⇒ reconnect. Default 30_000. 0 disables. */
  pingIntervalMs?: number;
  /**
   * Deadline for the socket-open → auth_ok handshake. Without it a connection
   * that opens but never completes auth (HA core hung behind the supervisor
   * proxy, silent network drop before auth_ok) would hang forever: reconnects
   * are driven by close/error events and app-level ping only starts after
   * auth_ok. Default 15_000. 0 disables.
   */
  handshakeTimeoutMs?: number;
  commandTimeoutMs?: number; // default 10_000
  /** Test seam: injected in tests with an in-process fake. Defaults to globalThis.WebSocket. */
  WebSocketImpl?: typeof WebSocket;
}

export interface HaClientStats {
  connected: boolean;
  haVersion: string | null;
  connectedSince: number | null; // ms epoch
  reconnects: number;
  eventsSeen: number;
  lastEventAt: number | null;    // ms epoch
  pendingCommands: number;
  subscriptions: number;
}

export interface HaClient {
  start(): void;
  /** Idempotent. Rejects all pending commands with HaDisconnectedError, closes the socket. */
  stop(): Promise<void>;
  readonly stats: HaClientStats;

  // Event surface. All on* return an unsubscribe function. Handlers survive reconnects.
  onStateChanged(handler: (e: HaStateChangedEvent) => void): () => void;
  onCallService(handler: (e: HaCallServiceEvent) => void): () => void;
  /** Generic escape hatch for other event types (zwave_js_value_notification etc. — M1). */
  onEvent(eventType: string, handler: (raw: { event: unknown; timeFired: number }) => void): () => void;
  /** Fired after EVERY auth_ok with the full get_states dump. reason "initial" on the first-ever connect of this client instance, "resync" on every reconnect. */
  onStatesSnapshot(handler: (snap: HaStatesSnapshot) => void): () => void;
  onConnectionChange(handler: (connected: boolean) => void): () => void;

  /** subscribe_trigger (sun/time_pattern/state...). Re-armed automatically after reconnect. */
  subscribeTrigger(trigger: Record<string, unknown>, handler: (variables: Record<string, unknown>) => void): Promise<() => Promise<void>>;

  // Commands (reject with HaCommandError / HaTimeoutError / HaDisconnectedError)
  getStates(): Promise<HaEntityState[]>;
  callService(req: HaCallServiceRequest): Promise<HaCallServiceResult>; // M0: shaped for SafeActuator, called by nothing
  listStatisticIds(): Promise<HaStatisticIdMeta[]>;
  statisticsDuringPeriod(req: HaStatisticsRequest): Promise<Record<string, HaStatisticValue[]>>;
  /** Raw command escape hatch: sends {id, ...message}, resolves the result payload. */
  send<T = unknown>(message: Record<string, unknown>): Promise<T>;
}

// ---------------------------------------------------------------------------
// internals

/** Minimal structural surface the client needs from a WebSocket instance. */
interface WsLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (evt: { data?: unknown }) => void): void;
}

type WsCtor = new (url: string) => WsLike;

const WS_OPEN = 1;
const WS_CLOSED = 3;

interface Pending {
  type: string;
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

interface EventReg {
  handlers: Set<(event: unknown) => void>;
  /** subscribe_events command id on the CURRENT connection; null when unsubscribed. */
  subId: number | null;
}

interface TriggerReg {
  trigger: Record<string, unknown>;
  handler: (variables: Record<string, unknown>) => void;
  subId: number | null;
}

function unrefTimer(t: unknown): void {
  (t as { unref?: () => void } | null)?.unref?.();
}

function parseTimeFired(event: unknown): number {
  const tf = (event as { time_fired?: unknown } | null)?.time_fired;
  const t = typeof tf === "string" ? Date.parse(tf) : NaN;
  return Number.isFinite(t) ? t : Date.now();
}

function mapStateChanged(event: unknown): HaStateChangedEvent {
  const ev = event as { data?: { entity_id?: unknown; new_state?: unknown; old_state?: unknown }; context?: unknown };
  const data = ev?.data ?? {};
  return {
    entityId: typeof data.entity_id === "string" ? data.entity_id : "",
    newState: (data.new_state ?? null) as HaEntityState | null,
    oldState: (data.old_state ?? null) as HaEntityState | null,
    timeFired: parseTimeFired(event),
    context: (ev?.context ?? null) as HaContext | null,
  };
}

/** Normalized union of service_data.entity_id (string|string[]) and service_data.target?.entity_id. */
function normalizeEntityIds(serviceData: Record<string, unknown>): string[] {
  const out: string[] = [];
  const push = (v: unknown): void => {
    if (typeof v === "string") {
      if (!out.includes(v)) out.push(v);
    } else if (Array.isArray(v)) {
      for (const x of v) push(x);
    }
  };
  push(serviceData["entity_id"]);
  push((serviceData["target"] as { entity_id?: unknown } | undefined)?.entity_id);
  return out;
}

function mapCallService(event: unknown): HaCallServiceEvent {
  const ev = event as { data?: { domain?: unknown; service?: unknown; service_data?: unknown }; context?: unknown };
  const data = ev?.data ?? {};
  const serviceData = (typeof data.service_data === "object" && data.service_data !== null
    ? data.service_data
    : {}) as Record<string, unknown>;
  return {
    domain: typeof data.domain === "string" ? data.domain : "",
    service: typeof data.service === "string" ? data.service : "",
    serviceData,
    entityIds: normalizeEntityIds(serviceData),
    timeFired: parseTimeFired(event),
    context: (ev?.context ?? null) as HaContext | null,
  };
}

// ---------------------------------------------------------------------------

export function createHaClient(opts: HaClientOptions): HaClient {
  const log = opts.log ?? (() => {});
  const wsImpl = (opts.WebSocketImpl ?? (globalThis as { WebSocket?: unknown }).WebSocket) as WsCtor | undefined;
  if (!wsImpl) throw new Error("No WebSocket implementation available (need Node 22+ or WebSocketImpl)");
  const WS: WsCtor = wsImpl;
  const initialBackoffMs = opts.backoff?.initialMs ?? 1_000;
  const maxBackoffMs = opts.backoff?.maxMs ?? 60_000;
  const jitterMs = opts.backoff?.jitterMs ?? 500;
  const pingIntervalMs = opts.pingIntervalMs ?? 30_000;
  const handshakeTimeoutMs = opts.handshakeTimeoutMs ?? 15_000;
  const commandTimeoutMs = opts.commandTimeoutMs ?? 10_000;

  let socket: WsLike | null = null;
  /** Bumped on every (re)connect and close; stale socket listeners check it and bail. */
  let generation = 0;
  let started = false;
  let stopped = false;
  let connected = false; // true only after auth_ok
  let everConnected = false;
  let haVersion: string | null = null;
  let connectedSince: number | null = null;
  let reconnects = 0;
  let eventsSeen = 0;
  let lastEventAt: number | null = null;
  let currentBackoffMs = 0; // 0 ⇒ next reconnect uses initialMs
  let nextId = 1; // per-connection command id counter
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  let awaitingPong = false;

  const pending = new Map<number, Pending>();
  const eventRegs = new Map<string, EventReg>();
  const triggerRegs = new Set<TriggerReg>();
  const snapshotHandlers = new Set<(snap: HaStatesSnapshot) => void>();
  const connectionHandlers = new Set<(connected: boolean) => void>();

  function safeCall<A>(fn: (a: A) => void, arg: A): void {
    try {
      fn(arg);
    } catch (err) {
      log("error", `HA handler threw: ${String(err)}`);
    }
  }

  function sendRaw(message: Record<string, unknown>): void {
    if (!socket || socket.readyState !== WS_OPEN) return;
    try {
      socket.send(JSON.stringify(message));
    } catch (err) {
      log("warn", `HA send failed: ${String(err)}`);
    }
  }

  /** Send a command with a fresh id; the id doubles as the subscription id for subscribe_* commands. */
  function commandWithId<T>(message: Record<string, unknown>, timeoutMs = commandTimeoutMs): { id: number; result: Promise<T> } {
    if (!connected || !socket || socket.readyState !== WS_OPEN) {
      return { id: -1, result: Promise.reject(new HaDisconnectedError()) };
    }
    const id = nextId++;
    const result = new Promise<T>((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
            pending.delete(id);
            reject(new HaTimeoutError(`HA command ${String(message["type"])} timed out after ${timeoutMs}ms`));
          }, timeoutMs)
        : null;
      unrefTimer(timer);
      pending.set(id, { type: String(message["type"]), resolve: resolve as (v: unknown) => void, reject, timer });
      sendRaw({ id, ...message });
    });
    return { id, result };
  }

  function command<T>(message: Record<string, unknown>, timeoutMs = commandTimeoutMs): Promise<T> {
    return commandWithId<T>(message, timeoutMs).result;
  }

  function rejectAllPending(err: Error): void {
    for (const p of pending.values()) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(err);
    }
    pending.clear();
  }

  // -- subscription management ----------------------------------------------

  function subscribeEventType(eventType: string, reg: EventReg): void {
    const { id, result } = commandWithId({ type: "subscribe_events", event_type: eventType });
    if (id === -1) return;
    reg.subId = id;
    result.catch((err) => {
      if (reg.subId === id) reg.subId = null;
      log("warn", `HA subscribe_events(${eventType}) failed: ${String(err)}`);
    });
  }

  function addEventHandler(eventType: string, raw: (event: unknown) => void): () => void {
    let reg = eventRegs.get(eventType);
    if (!reg) {
      reg = { handlers: new Set(), subId: null };
      eventRegs.set(eventType, reg);
    }
    reg.handlers.add(raw);
    if (connected && reg.subId === null) subscribeEventType(eventType, reg); // lazy subscribe
    return () => {
      if (!reg.handlers.delete(raw)) return;
      if (reg.handlers.size === 0 && reg.subId !== null) {
        const subId = reg.subId;
        reg.subId = null;
        if (connected) command({ type: "unsubscribe_events", subscription: subId }).catch(() => {});
      }
    };
  }

  async function armTrigger(reg: TriggerReg): Promise<void> {
    const { id, result } = commandWithId({ type: "subscribe_trigger", trigger: reg.trigger });
    await result;
    reg.subId = id;
  }

  // -- connection lifecycle -------------------------------------------------

  function connect(): void {
    if (stopped) return;
    generation++;
    const gen = generation;
    nextId = 1;
    awaitingPong = false;
    let ws: WsLike;
    try {
      ws = new WS(opts.url);
    } catch (err) {
      log("error", `HA connect to ${opts.url} failed: ${String(err)}`);
      scheduleReconnect();
      return;
    }
    socket = ws;
    // Handshake deadline: if auth_ok has not arrived when this fires, force a
    // close so the normal handleClose → scheduleReconnect path takes over.
    if (handshakeTimeoutMs > 0) {
      handshakeTimer = setTimeout(() => {
        handshakeTimer = null;
        if (gen !== generation || connected) return;
        log("warn", `HA handshake did not complete within ${handshakeTimeoutMs}ms; forcing reconnect`);
        try {
          ws.close();
        } catch {
          /* reconnect path continues via the close event */
        }
      }, handshakeTimeoutMs);
      unrefTimer(handshakeTimer);
    }
    ws.addEventListener("open", () => {
      if (gen !== generation) return;
      log("debug", "HA socket open, awaiting auth_required");
    });
    ws.addEventListener("message", (evt) => {
      if (gen !== generation) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(evt.data));
      } catch {
        log("warn", "HA sent unparseable frame");
        return;
      }
      if (Array.isArray(parsed)) for (const m of parsed) handleMessage(m);
      else handleMessage(parsed);
    });
    ws.addEventListener("error", () => {
      if (gen !== generation) return;
      log("warn", "HA socket error");
    });
    ws.addEventListener("close", () => {
      if (gen !== generation) return;
      handleClose();
    });
  }

  function clearHandshakeTimer(): void {
    if (handshakeTimer !== null) {
      clearTimeout(handshakeTimer);
      handshakeTimer = null;
    }
  }

  function handleClose(): void {
    const wasConnected = connected;
    connected = false;
    connectedSince = null;
    stopPing();
    clearHandshakeTimer();
    socket = null;
    generation++; // invalidate any remaining listeners of the dead socket
    rejectAllPending(new HaDisconnectedError());
    for (const reg of eventRegs.values()) reg.subId = null;
    for (const t of triggerRegs) t.subId = null;
    if (wasConnected) {
      log("info", "HA connection lost");
      for (const h of connectionHandlers) safeCall(h, false);
    }
    if (!stopped) scheduleReconnect();
  }

  function scheduleReconnect(): void {
    if (stopped || reconnectTimer !== null) return;
    currentBackoffMs = currentBackoffMs === 0 ? initialBackoffMs : Math.min(currentBackoffMs * 2, maxBackoffMs);
    const delay = currentBackoffMs + Math.floor(Math.random() * (jitterMs + 1));
    reconnects++;
    log("info", `HA reconnect #${reconnects} in ${delay}ms`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
    unrefTimer(reconnectTimer);
  }

  function startPing(): void {
    stopPing();
    if (pingIntervalMs <= 0) return;
    pingTimer = setInterval(() => {
      if (!connected || !socket) return;
      if (awaitingPong) {
        log("warn", "HA pong missed; forcing reconnect");
        try {
          socket.close();
        } catch {
          /* close path continues via the close event */
        }
        return;
      }
      awaitingPong = true;
      sendRaw({ id: nextId++, type: "ping" });
    }, pingIntervalMs);
    unrefTimer(pingTimer);
  }

  function stopPing(): void {
    if (pingTimer !== null) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
    awaitingPong = false;
  }

  // -- message handling -----------------------------------------------------

  function handleMessage(msg: unknown): void {
    const m = msg as { type?: unknown; id?: unknown } & Record<string, unknown>;
    switch (m?.type) {
      case "auth_required":
        sendRaw({ type: "auth", access_token: opts.token });
        break;
      case "auth_ok":
        onAuthOk(m);
        break;
      case "auth_invalid":
        // Token may be rotated at runtime; keep retrying at max backoff, never throw.
        log("error", `HA auth_invalid: ${String(m["message"] ?? "invalid access token")}`);
        currentBackoffMs = maxBackoffMs;
        try {
          socket?.close();
        } catch {
          /* reconnect path continues via the close event */
        }
        break;
      case "result":
        handleResult(m);
        break;
      case "pong":
        awaitingPong = false;
        break;
      case "event":
        handleEvent(m);
        break;
      default:
        break;
    }
  }

  function handleResult(m: Record<string, unknown>): void {
    const id = typeof m["id"] === "number" ? m["id"] : -1;
    const p = pending.get(id);
    if (!p) return; // late result after timeout/disconnect — drop
    pending.delete(id);
    if (p.timer) clearTimeout(p.timer);
    if (m["success"] === true) {
      p.resolve(m["result"]);
    } else {
      const err = (m["error"] ?? {}) as { code?: unknown; message?: unknown };
      p.reject(new HaCommandError(String(err.code ?? "unknown"), String(err.message ?? `HA command ${p.type} failed`)));
    }
  }

  function handleEvent(m: Record<string, unknown>): void {
    eventsSeen++;
    lastEventAt = Date.now();
    const id = typeof m["id"] === "number" ? m["id"] : -1;
    const event = m["event"];
    for (const reg of eventRegs.values()) {
      if (reg.subId === id) {
        for (const h of reg.handlers) safeCall(h, event);
        return;
      }
    }
    for (const t of triggerRegs) {
      if (t.subId === id) {
        const variables = (event as { variables?: unknown } | null)?.variables;
        safeCall(t.handler, (typeof variables === "object" && variables !== null ? variables : {}) as Record<string, unknown>);
        return;
      }
    }
    // Event for a subscription we no longer track (e.g. just unsubscribed) — ignore.
  }

  function onAuthOk(m: Record<string, unknown>): void {
    clearHandshakeTimer();
    haVersion = typeof m["ha_version"] === "string" ? m["ha_version"] : null;
    currentBackoffMs = 0; // reset backoff
    connected = true;
    connectedSince = Date.now();
    const reason: HaStatesSnapshot["reason"] = everConnected ? "resync" : "initial";
    everConnected = true;
    startPing();
    const gen = generation;
    void (async () => {
      // (a) re-issue subscribe_events for every event type with >=1 handler
      for (const [eventType, reg] of eventRegs) {
        if (gen !== generation) return;
        if (reg.handlers.size > 0 && reg.subId === null) subscribeEventType(eventType, reg);
      }
      // (b) re-arm all live trigger subscriptions with fresh ids
      for (const t of triggerRegs) {
        if (gen !== generation) return;
        try {
          await armTrigger(t);
        } catch (err) {
          log("warn", `HA subscribe_trigger re-arm failed: ${String(err)}`);
        }
      }
      // (c) full states dump -> snapshot
      try {
        const states = await command<HaEntityState[]>({ type: "get_states" });
        if (gen !== generation) return;
        const snap: HaStatesSnapshot = { states: states ?? [], reason, at: Date.now() };
        log("info", `HA connected (${haVersion ?? "unknown version"}), ${snap.states.length} states, reason=${reason}`);
        for (const h of snapshotHandlers) safeCall(h, snap);
      } catch (err) {
        if (gen !== generation) return;
        log("error", `HA get_states after auth_ok failed: ${String(err)}`);
        return; // connection likely dropped; reconnect path handles it
      }
      // (d) connection-change notification
      if (gen !== generation) return;
      for (const h of connectionHandlers) safeCall(h, true);
    })();
  }

  // -- public API -----------------------------------------------------------

  const client: HaClient = {
    start(): void {
      if (started || stopped) return;
      started = true;
      connect();
    },

    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      stopPing();
      clearHandshakeTimer();
      rejectAllPending(new HaDisconnectedError());
      connected = false;
      connectedSince = null;
      const ws = socket;
      if (ws && ws.readyState !== WS_CLOSED) {
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(resolve, 1_000);
          unrefTimer(timeout);
          ws.addEventListener("close", () => {
            clearTimeout(timeout);
            resolve();
          });
          try {
            ws.close();
          } catch {
            clearTimeout(timeout);
            resolve();
          }
        });
      }
      socket = null;
    },

    get stats(): HaClientStats {
      let subscriptions = 0;
      for (const reg of eventRegs.values()) if (reg.subId !== null) subscriptions++;
      for (const t of triggerRegs) if (t.subId !== null) subscriptions++;
      return {
        connected,
        haVersion,
        connectedSince,
        reconnects,
        eventsSeen,
        lastEventAt,
        pendingCommands: pending.size,
        subscriptions,
      };
    },

    onStateChanged(handler): () => void {
      return addEventHandler("state_changed", (event) => handler(mapStateChanged(event)));
    },

    onCallService(handler): () => void {
      return addEventHandler("call_service", (event) => handler(mapCallService(event)));
    },

    onEvent(eventType, handler): () => void {
      return addEventHandler(eventType, (event) => handler({ event, timeFired: parseTimeFired(event) }));
    },

    onStatesSnapshot(handler): () => void {
      snapshotHandlers.add(handler);
      return () => {
        snapshotHandlers.delete(handler);
      };
    },

    onConnectionChange(handler): () => void {
      connectionHandlers.add(handler);
      return () => {
        connectionHandlers.delete(handler);
      };
    },

    async subscribeTrigger(trigger, handler): Promise<() => Promise<void>> {
      const reg: TriggerReg = { trigger, handler, subId: null };
      await armTrigger(reg); // throws HaDisconnectedError / HaCommandError when it cannot arm
      triggerRegs.add(reg);
      return async () => {
        if (!triggerRegs.delete(reg)) return;
        if (reg.subId !== null) {
          const subId = reg.subId;
          reg.subId = null;
          if (connected) await command({ type: "unsubscribe_events", subscription: subId }).catch(() => {});
        }
      };
    },

    getStates(): Promise<HaEntityState[]> {
      return command<HaEntityState[]>({ type: "get_states" });
    },

    async callService(req): Promise<HaCallServiceResult> {
      const msg: Record<string, unknown> = { type: "call_service", domain: req.domain, service: req.service };
      if (req.serviceData !== undefined) msg["service_data"] = req.serviceData;
      if (req.target !== undefined) msg["target"] = req.target;
      if (req.returnResponse) msg["return_response"] = true;
      const res = await command<{ context: HaContext; response?: unknown }>(msg, req.timeoutMs ?? commandTimeoutMs);
      const out: HaCallServiceResult = { context: res?.context as HaContext };
      if (req.returnResponse) out.response = res?.response;
      return out;
    },

    async listStatisticIds(): Promise<HaStatisticIdMeta[]> {
      const res = await command<Array<Record<string, unknown>>>({ type: "recorder/list_statistic_ids" });
      return (res ?? []).map((item) => {
        const meanType = item["mean_type"] !== undefined
          ? (item["mean_type"] as 0 | 1 | 2)
          : item["has_mean"]
            ? 1
            : 0;
        return { ...item, mean_type: meanType } as unknown as HaStatisticIdMeta;
      });
    },

    async statisticsDuringPeriod(req): Promise<Record<string, HaStatisticValue[]>> {
      const msg: Record<string, unknown> = {
        type: "recorder/statistics_during_period",
        start_time: req.startTime,
        statistic_ids: req.statisticIds,
        period: req.period,
        types: req.types,
      };
      if (req.endTime !== undefined) msg["end_time"] = req.endTime;
      if (req.units !== undefined) msg["units"] = req.units;
      const res = await command<Record<string, HaStatisticValue[]>>(msg);
      return res ?? {};
    },

    send<T = unknown>(message: Record<string, unknown>): Promise<T> {
      return command<T>(message);
    },
  };

  return client;
}
