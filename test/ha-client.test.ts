// ha-client.test.ts — HaClient against an in-process fake HA WebSocket server.
// The fake implements the structural WebSocket surface the client uses
// (constructor, send, close, readyState, addEventListener) and is injected
// via HaClientOptions.WebSocketImpl. Server responses are synchronous; the
// connection "opens" on a microtask, so short real-timer settles suffice.

import { afterEach, describe, expect, it } from "vitest";
import { createHaClient, type HaClient, type HaClientOptions } from "../src/ha/client.js";
import {
  HaCommandError,
  HaDisconnectedError,
  HaTimeoutError,
  type HaCallServiceEvent,
  type HaEntityState,
  type HaStateChangedEvent,
  type HaStatesSnapshot,
} from "../src/ha/types.js";

// ---------------------------------------------------------------------------
// FakeHaSocket / FakeHaServer

type Listener = (evt: { data?: string }) => void;
type WireMsg = Record<string, unknown> & { type?: string; id?: number };

class FakeHaSocket {
  readyState = 0; // CONNECTING
  readonly sent: WireMsg[] = [];
  private listeners = new Map<string, Set<Listener>>();

  constructor(private server: FakeHaServer, readonly url: string) {}

  addEventListener(type: string, fn: Listener): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(fn);
  }

  private dispatch(type: string, evt: { data?: string } = {}): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(evt);
  }

  // client side
  send(data: string): void {
    if (this.readyState !== 1) throw new Error("socket not open");
    const msg = JSON.parse(data) as WireMsg;
    this.sent.push(msg);
    this.server.onClientMessage(this, msg);
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatch("close");
  }

  // server side
  open(): void {
    this.readyState = 1;
    this.dispatch("open");
  }

  serverSend(obj: unknown): void {
    this.dispatch("message", { data: JSON.stringify(obj) });
  }

  serverClose(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatch("close");
  }
}

interface FakeSub {
  socket: FakeHaSocket;
  id: number;
  eventType?: string;
  trigger?: unknown;
}

class FakeHaServer {
  readonly sockets: FakeHaSocket[] = [];
  validToken = "secret-token";
  haVersion = "2026.7.1";
  states: HaEntityState[] = [];
  statisticIds: Array<Record<string, unknown>> = [];
  statistics: Record<string, unknown> = {};
  /** Command types the server never answers (timeout tests). */
  readonly silent = new Set<string>();
  /** Command types the server fails with {code, message}. */
  readonly fail = new Map<string, { code: string; message: string }>();
  dropPong = false;
  /** When true, sockets open but the server never sends auth_required (stalled handshake). */
  silentHandshake = false;
  subscriptions: FakeSub[] = [];

  readonly WebSocketImpl: typeof WebSocket = (() => {
    // A `new`-able plain function so the constructor may return the fake socket.
    const server = this;
    return function (this: unknown, url: string) {
      const sock = new FakeHaSocket(server, url);
      server.sockets.push(sock);
      queueMicrotask(() => {
        if (sock.readyState !== 0) return;
        sock.open();
        if (!server.silentHandshake) sock.serverSend({ type: "auth_required", ha_version: server.haVersion });
      });
      return sock;
    } as unknown as typeof WebSocket;
  })();

  get current(): FakeHaSocket {
    const s = this.sockets[this.sockets.length - 1];
    if (!s) throw new Error("no socket yet");
    return s;
  }

  liveSubs(): FakeSub[] {
    return this.subscriptions.filter((s) => s.socket.readyState === 1);
  }

  onClientMessage(sock: FakeHaSocket, msg: WireMsg): void {
    const type = String(msg.type);
    if (type === "auth") {
      if (msg["access_token"] === this.validToken) sock.serverSend({ type: "auth_ok", ha_version: this.haVersion });
      else sock.serverSend({ type: "auth_invalid", message: "Invalid access token" });
      return;
    }
    if (type === "ping") {
      if (!this.dropPong) sock.serverSend({ id: msg.id, type: "pong" });
      return;
    }
    if (this.silent.has(type)) return;
    const failure = this.fail.get(type);
    if (failure) {
      sock.serverSend({ id: msg.id, type: "result", success: false, error: failure });
      return;
    }
    switch (type) {
      case "subscribe_events":
        this.subscriptions.push({ socket: sock, id: msg.id!, eventType: String(msg["event_type"]) });
        sock.serverSend({ id: msg.id, type: "result", success: true, result: null });
        break;
      case "subscribe_trigger":
        this.subscriptions.push({ socket: sock, id: msg.id!, trigger: msg["trigger"] });
        sock.serverSend({ id: msg.id, type: "result", success: true, result: null });
        break;
      case "unsubscribe_events":
        this.subscriptions = this.subscriptions.filter((s) => !(s.socket === sock && s.id === msg["subscription"]));
        sock.serverSend({ id: msg.id, type: "result", success: true, result: null });
        break;
      case "get_states":
        sock.serverSend({ id: msg.id, type: "result", success: true, result: this.states });
        break;
      case "call_service":
        sock.serverSend({
          id: msg.id,
          type: "result",
          success: true,
          result: { context: { id: "ctx-1", parent_id: null, user_id: null }, response: { ok: true } },
        });
        break;
      case "recorder/list_statistic_ids":
        sock.serverSend({ id: msg.id, type: "result", success: true, result: this.statisticIds });
        break;
      case "recorder/statistics_during_period":
        sock.serverSend({ id: msg.id, type: "result", success: true, result: this.statistics });
        break;
      default:
        sock.serverSend({ id: msg.id, type: "result", success: true, result: { echoed: type } });
    }
  }

  fireEvent(eventType: string, event: Record<string, unknown>): void {
    const sub = [...this.subscriptions].reverse().find((s) => s.eventType === eventType && s.socket.readyState === 1);
    if (!sub) throw new Error(`no live subscription for ${eventType}`);
    sub.socket.serverSend({ id: sub.id, type: "event", event });
  }

  fireTrigger(variables: Record<string, unknown>): void {
    const sub = [...this.subscriptions].reverse().find((s) => s.trigger !== undefined && s.socket.readyState === 1);
    if (!sub) throw new Error("no live trigger subscription");
    sub.socket.serverSend({ id: sub.id, type: "event", event: { variables } });
  }
}

// ---------------------------------------------------------------------------
// helpers

const settle = (ms = 5) => new Promise<void>((r) => setTimeout(r, ms));

function haState(entityId: string, state: string, attrs: Record<string, unknown> = {}): HaEntityState {
  return {
    entity_id: entityId,
    state,
    attributes: attrs,
    last_changed: "2026-07-19T09:00:00+00:00",
    last_updated: "2026-07-19T09:00:00+00:00",
  };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

function makeClient(server: FakeHaServer, extra?: Partial<HaClientOptions>): HaClient {
  const client = createHaClient({
    url: "ws://fake-ha/api/websocket",
    token: server.validToken,
    backoff: { initialMs: 5, maxMs: 20, jitterMs: 0 },
    pingIntervalMs: 0,
    commandTimeoutMs: 200,
    WebSocketImpl: server.WebSocketImpl,
    ...extra,
  });
  cleanups.push(() => client.stop());
  return client;
}

// ---------------------------------------------------------------------------

describe("HaClient auth flow + snapshot", () => {
  it("authenticates, emits initial snapshot, marks connected, and subscribes nothing without handlers", async () => {
    const server = new FakeHaServer();
    server.states = [haState("light.kitchen", "on"), haState("sensor.co2", "612")];
    const client = makeClient(server);
    const snapshots: HaStatesSnapshot[] = [];
    const connChanges: boolean[] = [];
    client.onStatesSnapshot((s) => snapshots.push(s));
    client.onConnectionChange((c) => connChanges.push(c));

    client.start();
    await settle();

    const auth = server.current.sent.find((m) => m.type === "auth");
    expect(auth).toBeDefined();
    expect(auth!["access_token"]).toBe("secret-token");

    // no handlers ⇒ lazy: no subscribe_events on the wire
    expect(server.current.sent.filter((m) => m.type === "subscribe_events")).toHaveLength(0);

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.reason).toBe("initial");
    expect(snapshots[0]!.states.map((s) => s.entity_id)).toEqual(["light.kitchen", "sensor.co2"]);
    expect(connChanges).toEqual([true]);

    const st = client.stats;
    expect(st.connected).toBe(true);
    expect(st.haVersion).toBe("2026.7.1");
    expect(st.connectedSince).not.toBeNull();
    expect(st.subscriptions).toBe(0);
  });

  it("lazily subscribes when a handler appears and unsubscribes when the last one is removed", async () => {
    const server = new FakeHaServer();
    const client = makeClient(server);
    client.start();
    await settle();

    const unsub = client.onStateChanged(() => {});
    await settle();
    const subs = server.current.sent.filter((m) => m.type === "subscribe_events");
    expect(subs).toHaveLength(1);
    expect(subs[0]!["event_type"]).toBe("state_changed");
    expect(client.stats.subscriptions).toBe(1);

    unsub();
    await settle();
    const unsubs = server.current.sent.filter((m) => m.type === "unsubscribe_events");
    expect(unsubs).toHaveLength(1);
    expect(unsubs[0]!["subscription"]).toBe(subs[0]!.id);
    expect(client.stats.subscriptions).toBe(0);
    expect(server.liveSubs()).toHaveLength(0);
  });

  it("subscribes registered event types on auth_ok, before the states snapshot", async () => {
    const server = new FakeHaServer();
    const client = makeClient(server);
    client.onStateChanged(() => {});
    client.onCallService(() => {});
    client.start();
    await settle();

    const sent = server.current.sent;
    const types = sent.filter((m) => m.type === "subscribe_events").map((m) => m["event_type"]);
    expect(types.sort()).toEqual(["call_service", "state_changed"]);
    const lastSubIdx = sent.map((m) => m.type).lastIndexOf("subscribe_events");
    const statesIdx = sent.map((m) => m.type).indexOf("get_states");
    expect(lastSubIdx).toBeGreaterThanOrEqual(0);
    expect(statesIdx).toBeGreaterThan(lastSubIdx); // (a) before (c)
    expect(client.stats.subscriptions).toBe(2);
  });

  it("keeps retrying at max backoff on auth_invalid without throwing", async () => {
    const server = new FakeHaServer();
    const client = makeClient(server, { token: "wrong-token", backoff: { initialMs: 5, maxMs: 10, jitterMs: 0 } });
    client.start();
    await settle(60);

    expect(client.stats.connected).toBe(false);
    expect(server.sockets.length).toBeGreaterThanOrEqual(2); // retried after auth_invalid
    for (const sock of server.sockets.slice(0, 2)) {
      expect(sock.sent.some((m) => m.type === "auth")).toBe(true);
      expect(sock.sent.some((m) => m.type === "get_states")).toBe(false); // never authed
    }
    expect(client.stats.reconnects).toBeGreaterThanOrEqual(1);
  });
});

describe("HaClient events", () => {
  it("maps state_changed with full state objects and tracks stats", async () => {
    const server = new FakeHaServer();
    const client = makeClient(server);
    const seen: HaStateChangedEvent[] = [];
    client.onStateChanged((e) => seen.push(e));
    client.start();
    await settle();

    const timeFired = "2026-07-19T10:15:30.123+00:00";
    server.fireEvent("state_changed", {
      event_type: "state_changed",
      data: {
        entity_id: "sensor.co2",
        old_state: haState("sensor.co2", "600", { unit_of_measurement: "ppm" }),
        new_state: haState("sensor.co2", "650", { unit_of_measurement: "ppm" }),
      },
      time_fired: timeFired,
      context: { id: "ctx-abc", parent_id: null, user_id: null },
    });

    expect(seen).toHaveLength(1);
    const e = seen[0]!;
    expect(e.entityId).toBe("sensor.co2");
    expect(e.newState?.state).toBe("650");
    expect(e.newState?.attributes["unit_of_measurement"]).toBe("ppm"); // full state, not just .state
    expect(e.oldState?.state).toBe("600");
    expect(e.timeFired).toBe(Date.parse(timeFired));
    expect(e.context?.id).toBe("ctx-abc");

    // entity removed ⇒ new_state null
    server.fireEvent("state_changed", {
      event_type: "state_changed",
      data: { entity_id: "sensor.gone", old_state: haState("sensor.gone", "1"), new_state: null },
      time_fired: timeFired,
      context: null,
    });
    expect(seen[1]!.newState).toBeNull();
    expect(seen[1]!.context).toBeNull();

    expect(client.stats.eventsSeen).toBe(2);
    expect(client.stats.lastEventAt).not.toBeNull();
  });

  it("normalizes call_service entityIds: string, array, target, absent, deduped", async () => {
    const server = new FakeHaServer();
    const client = makeClient(server);
    const seen: HaCallServiceEvent[] = [];
    client.onCallService((e) => seen.push(e));
    client.start();
    await settle();

    const fire = (serviceData: Record<string, unknown>) =>
      server.fireEvent("call_service", {
        event_type: "call_service",
        data: { domain: "light", service: "turn_on", service_data: serviceData },
        time_fired: "2026-07-19T10:00:00+00:00",
        context: { id: "c1", parent_id: "p1", user_id: "u1" },
      });

    fire({ entity_id: "light.lamp", brightness: 128 });
    fire({ entity_id: ["light.a", "light.b", "light.a"] });
    fire({ entity_id: "light.a", target: { entity_id: ["light.c"] } });
    fire({ brightness: 42 });

    expect(seen.map((e) => e.entityIds)).toEqual([
      ["light.lamp"],
      ["light.a", "light.b"],
      ["light.a", "light.c"],
      [],
    ]);
    expect(seen[0]!.domain).toBe("light");
    expect(seen[0]!.service).toBe("turn_on");
    expect(seen[0]!.serviceData["brightness"]).toBe(128);
    expect(seen[0]!.context?.parent_id).toBe("p1");
    expect(seen[0]!.timeFired).toBe(Date.parse("2026-07-19T10:00:00+00:00"));
  });

  it("dispatches generic onEvent by event type and unsubscribes independently", async () => {
    const server = new FakeHaServer();
    const client = makeClient(server);
    const raws: Array<{ event: unknown; timeFired: number }> = [];
    const unsub = client.onEvent("zwave_js_value_notification", (r) => raws.push(r));
    client.start();
    await settle();

    server.fireEvent("zwave_js_value_notification", {
      event_type: "zwave_js_value_notification",
      data: { value: 3 },
      time_fired: "2026-07-19T11:00:00+00:00",
    });
    expect(raws).toHaveLength(1);
    expect((raws[0]!.event as { data: { value: number } }).data.value).toBe(3);
    expect(raws[0]!.timeFired).toBe(Date.parse("2026-07-19T11:00:00+00:00"));

    unsub();
    await settle();
    expect(server.liveSubs()).toHaveLength(0);
  });
});

describe("HaClient commands", () => {
  it("resolves successful results and assigns increasing per-connection ids", async () => {
    const server = new FakeHaServer();
    const client = makeClient(server);
    client.start();
    await settle();

    const res = await client.send<{ echoed: string }>({ type: "custom/thing" });
    expect(res).toEqual({ echoed: "custom/thing" });

    const states = await client.getStates();
    expect(states).toEqual(server.states);

    const ids = server.current.sent.filter((m) => typeof m.id === "number").map((m) => m.id!);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("rejects with HaCommandError carrying the HA error code on success:false", async () => {
    const server = new FakeHaServer();
    server.fail.set("custom/bad", { code: "not_allowed", message: "nope" });
    const client = makeClient(server);
    client.start();
    await settle();

    const err = await client.send({ type: "custom/bad" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HaCommandError);
    expect((err as HaCommandError).code).toBe("not_allowed");
    expect((err as HaCommandError).message).toBe("nope");
  });

  it("rejects with HaTimeoutError when the server never answers, and clears the pending", async () => {
    const server = new FakeHaServer();
    server.silent.add("custom/slow");
    const client = makeClient(server, { commandTimeoutMs: 30 });
    client.start();
    await settle();

    const p = client.send({ type: "custom/slow" });
    p.catch(() => {});
    expect(client.stats.pendingCommands).toBe(1);
    await expect(p).rejects.toBeInstanceOf(HaTimeoutError);
    expect(client.stats.pendingCommands).toBe(0);
  });

  it("rejects with HaDisconnectedError when not connected", async () => {
    const server = new FakeHaServer();
    const client = makeClient(server);
    await expect(client.getStates()).rejects.toBeInstanceOf(HaDisconnectedError); // never started
  });

  it("maps call_service results and includes response only when requested", async () => {
    const server = new FakeHaServer();
    const client = makeClient(server);
    client.start();
    await settle();

    const plain = await client.callService({ domain: "light", service: "turn_on", serviceData: { brightness: 1 }, target: { entity_id: "light.x" } });
    expect(plain.context.id).toBe("ctx-1");
    expect("response" in plain).toBe(false);

    const withResp = await client.callService({ domain: "weather", service: "get_forecasts", returnResponse: true });
    expect(withResp.response).toEqual({ ok: true });

    const wire = server.current.sent.filter((m) => m.type === "call_service");
    expect(wire[0]!["service_data"]).toEqual({ brightness: 1 });
    expect(wire[0]!["target"]).toEqual({ entity_id: "light.x" });
    expect(wire[0]!["return_response"]).toBeUndefined();
    expect(wire[1]!["return_response"]).toBe(true);
  });
});

describe("HaClient reconnect", () => {
  it("rejects pendings, resubscribes with fresh ids, and emits a resync snapshot", async () => {
    const server = new FakeHaServer();
    server.silent.add("custom/slow");
    const client = makeClient(server);
    const snapshots: HaStatesSnapshot[] = [];
    const connChanges: boolean[] = [];
    const events: HaStateChangedEvent[] = [];
    client.onStatesSnapshot((s) => snapshots.push(s));
    client.onConnectionChange((c) => connChanges.push(c));
    client.onStateChanged((e) => events.push(e));
    client.start();
    await settle();
    expect(snapshots.map((s) => s.reason)).toEqual(["initial"]);
    const firstSocket = server.current;

    const p = client.send({ type: "custom/slow" });
    p.catch(() => {});
    await settle(1);
    expect(client.stats.pendingCommands).toBe(1);

    server.current.serverClose();
    await expect(p).rejects.toBeInstanceOf(HaDisconnectedError);
    expect(client.stats.connected).toBe(false);
    expect(connChanges).toEqual([true, false]);

    await settle(40); // backoff initialMs 5 ⇒ reconnected by now
    expect(server.sockets.length).toBe(2);
    expect(server.current).not.toBe(firstSocket);
    expect(client.stats.connected).toBe(true);
    expect(client.stats.reconnects).toBe(1);
    expect(snapshots.map((s) => s.reason)).toEqual(["initial", "resync"]);
    expect(connChanges).toEqual([true, false, true]);

    // resubscribed on the new connection with a fresh per-connection id (counter restarts at 1)
    const resub = server.current.sent.find((m) => m.type === "subscribe_events");
    expect(resub).toBeDefined();
    expect(resub!["event_type"]).toBe("state_changed");
    expect(resub!.id).toBe(1);

    // handler survived the reconnect
    server.fireEvent("state_changed", {
      event_type: "state_changed",
      data: { entity_id: "light.k", old_state: null, new_state: haState("light.k", "on") },
      time_fired: "2026-07-19T12:00:00+00:00",
      context: null,
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.entityId).toBe("light.k");
  });

  it("re-arms subscribe_trigger after reconnect and unsubscribes on demand", async () => {
    const server = new FakeHaServer();
    const client = makeClient(server);
    client.start();
    await settle();

    const vars: Array<Record<string, unknown>> = [];
    const unsub = await client.subscribeTrigger({ platform: "time_pattern", minutes: "/5" }, (v) => vars.push(v));
    expect(server.liveSubs().filter((s) => s.trigger !== undefined)).toHaveLength(1);
    expect(client.stats.subscriptions).toBe(1);

    server.fireTrigger({ trigger: { now: "t0" } });
    expect(vars).toHaveLength(1);
    expect(vars[0]).toEqual({ trigger: { now: "t0" } });

    server.current.serverClose();
    await settle(40);
    expect(client.stats.connected).toBe(true);

    // re-armed on the new socket with a fresh id
    const rearmed = server.current.sent.filter((m) => m.type === "subscribe_trigger");
    expect(rearmed).toHaveLength(1);
    expect(rearmed[0]!["trigger"]).toEqual({ platform: "time_pattern", minutes: "/5" });
    server.fireTrigger({ trigger: { now: "t1" } });
    expect(vars).toHaveLength(2);

    await unsub();
    expect(server.liveSubs().filter((s) => s.trigger !== undefined)).toHaveLength(0);
    expect(client.stats.subscriptions).toBe(0);
  });

  it("rejects subscribeTrigger while disconnected", async () => {
    const server = new FakeHaServer();
    const client = makeClient(server);
    await expect(client.subscribeTrigger({ platform: "sun" }, () => {})).rejects.toBeInstanceOf(HaDisconnectedError);
  });

  it("forces a reconnect when a pong is missed", async () => {
    const server = new FakeHaServer();
    server.dropPong = true;
    const client = makeClient(server, { pingIntervalMs: 10 });
    client.start();
    await settle();
    expect(client.stats.connected).toBe(true);
    expect(server.sockets.length).toBe(1);

    await settle(60); // tick1 ping (dropped), tick2 miss ⇒ force close ⇒ reconnect
    expect(server.sockets.length).toBeGreaterThanOrEqual(2);
    expect(client.stats.reconnects).toBeGreaterThanOrEqual(1);
    const pings = server.sockets[0]!.sent.filter((m) => m.type === "ping");
    expect(pings.length).toBe(1); // second tick closed instead of pinging again
  });

  it("does not reconnect while pongs flow", async () => {
    const server = new FakeHaServer();
    const client = makeClient(server, { pingIntervalMs: 10 });
    client.start();
    await settle(55);
    expect(client.stats.connected).toBe(true);
    expect(client.stats.reconnects).toBe(0);
    expect(server.sockets.length).toBe(1);
    expect(server.current.sent.filter((m) => m.type === "ping").length).toBeGreaterThanOrEqual(2);
  });

  it("force-reconnects when the handshake never completes (socket open, no auth_ok)", async () => {
    // Without a handshake deadline this scenario hangs forever: no close/error
    // event ever fires and app-level ping only starts after auth_ok.
    const server = new FakeHaServer();
    server.silentHandshake = true;
    const client = makeClient(server, { handshakeTimeoutMs: 30 });
    client.start();
    await settle(15); // socket open, handshake stalled, deadline not yet reached
    expect(client.stats.connected).toBe(false);
    expect(server.sockets.length).toBe(1);

    server.silentHandshake = false; // the next connection will handshake normally
    await settle(100); // deadline (30ms) fires ⇒ close ⇒ backoff (5ms) ⇒ reconnect ⇒ auth_ok
    expect(server.sockets.length).toBeGreaterThanOrEqual(2);
    expect(client.stats.reconnects).toBeGreaterThanOrEqual(1);
    expect(client.stats.connected).toBe(true);
  });
});

describe("HaClient recorder commands", () => {
  it("derives mean_type from legacy has_mean and passes post-2025 items through", async () => {
    const server = new FakeHaServer();
    server.statisticIds = [
      { statistic_id: "sensor.energy", source: "recorder", name: null, display_unit_of_measurement: "kWh", unit_class: "energy", has_sum: true, has_mean: false },
      { statistic_id: "sensor.temp", source: "recorder", name: "Temp", display_unit_of_measurement: "°C", unit_class: "temperature", has_sum: false, has_mean: true },
      { statistic_id: "sensor.wind_dir", source: "recorder", name: null, display_unit_of_measurement: "°", unit_class: null, has_sum: false, mean_type: 2 },
    ];
    const client = makeClient(server);
    client.start();
    await settle();

    const metas = await client.listStatisticIds();
    expect(metas.map((m) => [m.statistic_id, m.mean_type])).toEqual([
      ["sensor.energy", 0],
      ["sensor.temp", 1],
      ["sensor.wind_dir", 2],
    ]);
  });

  it("sends the statistics_during_period wire shape and passes the response through", async () => {
    const server = new FakeHaServer();
    server.statistics = {
      "sensor.energy": [{ start: 1_752_900_000_000, end: 1_752_903_600_000, sum: 12.5, change: 0.7 }],
    };
    const client = makeClient(server);
    client.start();
    await settle();

    const res = await client.statisticsDuringPeriod({
      statisticIds: ["sensor.energy"],
      startTime: "2026-07-19T00:00:00Z",
      endTime: "2026-07-19T12:00:00Z",
      period: "hour",
      types: ["sum", "change"],
      units: { energy: "kWh" },
    });
    expect(res["sensor.energy"]![0]!.sum).toBe(12.5);

    const wire = server.current.sent.find((m) => m.type === "recorder/statistics_during_period")!;
    expect(wire["start_time"]).toBe("2026-07-19T00:00:00Z");
    expect(wire["end_time"]).toBe("2026-07-19T12:00:00Z");
    expect(wire["statistic_ids"]).toEqual(["sensor.energy"]);
    expect(wire["period"]).toBe("hour");
    expect(wire["types"]).toEqual(["sum", "change"]);
    expect(wire["units"]).toEqual({ energy: "kWh" });
  });
});

describe("HaClient stop", () => {
  it("is idempotent, rejects pendings, closes the socket, and blocks restart", async () => {
    const server = new FakeHaServer();
    server.silent.add("custom/slow");
    const client = makeClient(server);
    client.start();
    await settle();

    const p = client.send({ type: "custom/slow" });
    p.catch(() => {});
    await settle(1);

    await client.stop();
    await expect(p).rejects.toBeInstanceOf(HaDisconnectedError);
    expect(server.current.readyState).toBe(3);
    expect(client.stats.connected).toBe(false);

    await client.stop(); // idempotent
    client.start(); // no-op after stop
    await settle(10);
    expect(server.sockets.length).toBe(1);
  });

  it("does not reconnect after stop", async () => {
    const server = new FakeHaServer();
    const client = makeClient(server);
    client.start();
    await settle();
    await client.stop();
    await settle(40);
    expect(server.sockets.length).toBe(1);
  });
});
