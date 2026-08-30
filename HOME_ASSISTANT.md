# TEOB Home Assistant Addon — Architecture

## Overview

A Home Assistant addon that runs automations as TEOB aggregate entities. Home automation rules are expressed as pure, testable, event-sourced aggregates — the same abstraction used for backend services. The addon subscribes to HA state/events via WebSocket, routes them as commands to aggregate entities, and calls HA services as side effects.

```
┌─────────────────────────────────────────────────────────────┐
│  Home Assistant (hassio.local:8123)                         │
│                                                             │
│  Entities          Services          Events                 │
│  light.*           light/turn_on     state_changed          │
│  sensor.*          climate/set_*     automation_triggered    │
│  binary_sensor.*   switch/toggle     time_pattern           │
│                                                             │
│─────────── WebSocket API (ws://supervisor/core/websocket) ──│
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  TEOB Addon Container                                 │  │
│  │                                                       │  │
│  │  ┌─────────────┐   ┌──────────────┐                   │  │
│  │  │  HA Client   │──▶│  HA Bridge   │                   │  │
│  │  │  (WebSocket) │   │  (Router)    │                   │  │
│  │  └─────────────┘   └──────┬───────┘                   │  │
│  │                           │ Commands                   │  │
│  │                    ┌──────▼───────┐                    │  │
│  │                    │   InMem      │                    │  │
│  │                    │   Runtime    │                    │  │
│  │                    └──────┬───────┘                    │  │
│  │           ┌───────────────┼───────────────┐            │  │
│  │     ┌─────▼─────┐  ┌─────▼─────┐  ┌──────▼──────┐    │  │
│  │     │ Motion    │  │ Climate   │  │ Presence    │    │  │
│  │     │ Light     │  │ Control   │  │ Manager     │    │  │
│  │     │ Aggregate │  │ Aggregate │  │ Aggregate   │    │  │
│  │     └───────────┘  └───────────┘  └─────────────┘    │  │
│  │                                                       │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────────┐        │  │
│  │  │ Probe    │  │ Ingress  │  │ Event Store  │        │  │
│  │  │ Server   │  │ UI       │  │ (journal)    │        │  │
│  │  │ :9095    │  │ :8099    │  │              │        │  │
│  │  └──────────┘  └──────────┘  └──────────────┘        │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

## Development vs Production

The addon must work in two modes with the same aggregate code.

### Development Mode (local machine)

Run the automation engine on your dev machine, connecting to HA remotely via long-lived access token. Fast iteration — no Docker build, no addon install.

```
Developer Machine                         Home Assistant
┌──────────────────────┐                   ┌──────────────┐
│ tsx watch src/main.ts│──── WebSocket ───▶│ :8123        │
│                      │◀── state_changed──│              │
│ InMem Runtime        │── call_service ──▶│              │
│ Aggregates           │                   │              │
│ Probe :9095          │                   │              │
│ UI    :8099          │                   │              │
└──────────────────────┘                   └──────────────┘
```

**Connection**: `ws://hassio.local:8123/api/websocket` with a long-lived access token from HA UI (Profile → Long-Lived Access Tokens).

**Config**: `.env` file or environment variables:

```bash
HA_URL=ws://hassio.local:8123/api/websocket
HA_TOKEN=eyJ0eXAiOi...                       # long-lived access token
HA_MODE=development
```

**Run**:
```bash
cd ts
npm run dev    # tsx watch — auto-reload on file changes
```

### Production Mode (HA addon)

Runs inside a Docker container managed by the HA Supervisor. Auth is automatic via `SUPERVISOR_TOKEN`.

```
Home Assistant OS / Supervised
┌──────────────────────────────────────────────┐
│  Supervisor                                   │
│  ┌────────────────────────────┐               │
│  │  TEOB Addon Container      │               │
│  │  node dist/main.js         │               │
│  │                            │               │
│  │  ws://supervisor/core/     │──────┐        │
│  │    websocket               │      │        │
│  └────────────────────────────┘      │        │
│                                      ▼        │
│  ┌────────────────────────────────────────┐   │
│  │  Home Assistant Core                   │   │
│  └────────────────────────────────────────┘   │
└──────────────────────────────────────────────┘
```

**Connection**: `ws://supervisor/core/websocket` with `SUPERVISOR_TOKEN` (injected by Supervisor).

**Config**: User options via HA UI, read from `/data/options.json`.

## HA Client Abstraction

A single `HaClient` interface hides the dev/prod connection difference. Everything above this layer is identical in both modes.

```typescript
interface HaClient {
  /** Subscribe to HA events by type. Returns unsubscribe function. */
  subscribeEvents(
    eventType: string,
    callback: (event: HaEvent) => void,
  ): Promise<() => void>;

  /** Subscribe to specific trigger (same schema as HA automation triggers). */
  subscribeTrigger(
    trigger: HaTrigger,
    callback: (event: HaEvent) => void,
  ): Promise<() => void>;

  /** Call a HA service. */
  callService(
    domain: string,
    service: string,
    data?: Record<string, unknown>,
    target?: HaTarget,
  ): Promise<void>;

  /** Get current state of an entity. */
  getState(entityId: string): Promise<HaEntityState | undefined>;

  /** Get all entity states. */
  getStates(): Promise<HaEntityState[]>;

  /** Fire a custom event. */
  fireEvent(eventType: string, data?: Record<string, unknown>): Promise<void>;

  /** Connection health. */
  isConnected(): boolean;

  /** Graceful disconnect. */
  disconnect(): Promise<void>;
}

interface HaEntityState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string;
  last_updated: string;
}

interface HaEvent {
  event_type: string;
  data: Record<string, unknown>;
  origin: string;
  time_fired: string;
}

interface HaTarget {
  entity_id?: string | string[];
  device_id?: string | string[];
  area_id?: string | string[];
}

interface HaTrigger {
  platform: string;
  [key: string]: unknown;
}
```

### Connection Factory

```typescript
function createHaClient(config: HaConfig): HaClient

type HaConfig =
  | { mode: "development"; url: string; token: string }
  | { mode: "production" }  // reads SUPERVISOR_TOKEN from env, connects to ws://supervisor/core/websocket

function resolveHaConfig(): HaConfig {
  if (process.env.HA_MODE === "development") {
    return {
      mode: "development",
      url: process.env.HA_URL!,
      token: process.env.HA_TOKEN!,
    };
  }
  return { mode: "production" };
}
```

## HA Bridge — Routing HA Events to TEOB Commands

The bridge layer converts HA events into TEOB commands and dispatches them to the correct aggregate entity. It also provides a way for aggregates to call HA services as side effects.

### Subscription Registrations

Each aggregate declares what HA events it cares about via a `HaSubscription`:

```typescript
interface HaSubscription<Command> {
  /** What to subscribe to. */
  trigger: HaSubscriptionTrigger;
  /** Convert an HA event into a command (or undefined to skip). */
  toCommand: (event: HaEvent, states: HaStateResolver) => Command | undefined;
  /** Which entity instance should receive the command. */
  routeTo: (event: HaEvent) => EntityId;
}

type HaSubscriptionTrigger =
  | { type: "state_changed"; entityId: string }
  | { type: "state_changed"; entityIdPrefix: string }
  | { type: "event"; eventType: string }
  | { type: "time_pattern"; hours?: string; minutes?: string; seconds?: string }
  | { type: "ha_trigger"; trigger: HaTrigger };  // raw HA trigger schema

/** Resolve current HA state — available during command translation. */
interface HaStateResolver {
  get(entityId: string): HaEntityState | undefined;
}
```

### Automation Registration

Bundles an aggregate with its HA subscriptions and codec:

```typescript
interface AutomationRegistration<Command, Reply, Event, State> {
  aggregate: Aggregate<Command, Reply, Event, State>;
  eventCodec: Codec<Event>;
  stateCodec: Codec<State>;
  subscriptions: HaSubscription<Command>[];
}
```

### Bridge Lifecycle

```typescript
interface HaBridge {
  /** Start all subscriptions, routing events to the runtime. */
  start(runtime: EntityRuntime, haClient: HaClient): Promise<void>;
  /** Tear down all subscriptions. */
  shutdown(): Promise<void>;
}

function createHaBridge(
  registrations: AutomationRegistration<any, any, any, any>[],
): HaBridge;
```

The bridge:
1. Subscribes to HA events per each registration's triggers.
2. On event: calls `toCommand()` to convert, `routeTo()` for the entity ID, then `runtime.tell()`.
3. Maintains a state cache (refreshed on `state_changed`) so `HaStateResolver` is available during command mapping.

### HA Service Helper for Aggregates

Aggregates call HA services via `Effect.Run`. A helper wraps the client:

```typescript
/** Create HA service call functions bound to an HaClient. Passed to aggregates via closure. */
interface HaActions {
  turnOn(entityId: string, data?: Record<string, unknown>): () => Promise<void>;
  turnOff(entityId: string): () => Promise<void>;
  toggle(entityId: string): () => Promise<void>;
  callService(domain: string, service: string, data?: Record<string, unknown>, target?: HaTarget): () => Promise<void>;
  notify(message: string, title?: string, target?: string): () => Promise<void>;
}

function createHaActions(client: HaClient): HaActions;
```

Usage inside an aggregate's decide function:

```typescript
// ha is an HaActions instance, closed over the HaClient
return persist({ tag: "Activated", at: Date.now() })
  .andRun(ha.turnOn("light.living_room", { brightness: 255 }))
  .andRun(ha.notify("Motion detected in living room"));
```

The functions return `() => Promise<void>` — matching the shape `Effect.Run` expects.

## ServiceTemplate Wiring

The addon uses the existing `ServiceTemplate` for lifecycle management.

```typescript
const addonService: ServiceTemplate<Infra, Outside, Entities, Context> = {
  config: {
    probeServer: { host: "0.0.0.0", port: 9095 },
    httpServer: { host: "0.0.0.0", port: 8099 },     // ingress UI
  },

  async infra() {
    const haConfig = resolveHaConfig();
    const haClient = createHaClient(haConfig);
    return { haClient };
  },

  async outside(infra) {
    const ha = createHaActions(infra.haClient);
    return { ha };
  },

  async entities(infra, outside) {
    // Register automation aggregates
    const registrations = buildAutomationRegistrations(outside.ha);
    const { runtime, journal } = createInMemoryRuntime(
      registrations.map((r) => registration(r.aggregate, r.eventCodec, r.stateCodec)),
    );
    const bridge = createHaBridge(registrations);
    await runtime.start();
    await bridge.start(runtime, infra.haClient);
    return { runtime, journal, bridge };
  },

  async context(infra, outside, entities) {
    return { infra, outside, entities };
  },

  infraHealthChecks(infra) {
    return [
      simpleHealthCheck("ha-websocket", async () =>
        infra.haClient.isConnected()
          ? HealthStatus.Healthy
          : HealthStatus.Unhealthy("disconnected from Home Assistant"),
      ),
    ];
  },

  async teardownEntities(entities) {
    await entities.bridge.shutdown();
    await entities.runtime.shutdown();
  },

  async teardownInfra(infra) {
    await infra.haClient.disconnect();
  },
};
```

## Example Aggregate: Motion-Activated Light

```typescript
// --- Domain types ---

type MotionLightState = {
  mode: "idle" | "active";
  triggerCount: number;
};

type MotionLightCommand =
  | { tag: "MotionDetected"; sensor: string }
  | { tag: "MotionCleared"; sensor: string }
  | { tag: "TurnOffTimeout" }
  | { tag: "ManualOverride" };

type MotionLightEvent =
  | { tag: "Activated"; sensor: string; at: number }
  | { tag: "Deactivated"; reason: "timeout" | "manual"; at: number };

type MotionLightReply = void;

// --- Aggregate ---

function motionLightAggregate(ha: HaActions): Aggregate<
  MotionLightCommand, MotionLightReply, MotionLightEvent, MotionLightState
> {
  return {
    category: CategoryId("motion-light"),

    initial: () => ({ mode: "idle", triggerCount: 0 }),

    async decide(state, cmd, ctx) {
      switch (cmd.tag) {
        case "MotionDetected": {
          // Reset turn-off timer on every motion
          await ctx.cancelTimer(TimerId("off"));
          await ctx.scheduleOnce(TimerId("off"), { tag: "TurnOffTimeout" }, 5 * 60_000);

          if (state.mode === "idle") {
            return persist<MotionLightEvent, MotionLightReply>(
              { tag: "Activated", sensor: cmd.sensor, at: Date.now() },
            ).andRun(ha.turnOn("light.living_room", { brightness: 255 }));
          }
          return done();
        }

        case "TurnOffTimeout": {
          if (state.mode === "active") {
            return persist<MotionLightEvent, MotionLightReply>(
              { tag: "Deactivated", reason: "timeout", at: Date.now() },
            ).andRun(ha.turnOff("light.living_room"));
          }
          return done();
        }

        case "ManualOverride": {
          if (state.mode === "active") {
            await ctx.cancelTimer(TimerId("off"));
            return persist<MotionLightEvent, MotionLightReply>(
              { tag: "Deactivated", reason: "manual", at: Date.now() },
            );
          }
          return done();
        }

        default:
          return done();
      }
    },

    apply(state, event) {
      switch (event.tag) {
        case "Activated":
          return { mode: "active", triggerCount: state.triggerCount + 1 };
        case "Deactivated":
          return { mode: "idle", triggerCount: state.triggerCount };
      }
    },

    invariants: [
      { name: "triggerCount non-negative", check: (s) => s.triggerCount >= 0 },
    ],
  };
}

// --- HA subscription wiring ---

function motionLightRegistration(ha: HaActions): AutomationRegistration<
  MotionLightCommand, MotionLightReply, MotionLightEvent, MotionLightState
> {
  return {
    aggregate: motionLightAggregate(ha),
    eventCodec: tagCodec<MotionLightEvent>(),
    stateCodec: objectCodec<MotionLightState>("MotionLightState"),
    subscriptions: [
      {
        trigger: { type: "state_changed", entityIdPrefix: "binary_sensor.motion_" },
        toCommand(event) {
          const data = event.data as { entity_id: string; new_state?: { state: string } };
          if (data.new_state?.state === "on") {
            return { tag: "MotionDetected", sensor: data.entity_id };
          }
          if (data.new_state?.state === "off") {
            return { tag: "MotionCleared", sensor: data.entity_id };
          }
          return undefined;
        },
        routeTo(event) {
          // Route by room — strip "binary_sensor.motion_" prefix
          const entityId = (event.data as { entity_id: string }).entity_id;
          return EntityId(entityId.replace("binary_sensor.motion_", ""));
        },
      },
    ],
  };
}
```

## Testing

Aggregates are testable without a running Home Assistant, using the existing `AggregateTestKit`:

```typescript
test("motion activates light", async () => {
  const ha = mockHaActions();
  const kit = createAggregateTestKit(motionLightAggregate(ha));

  const effect = await kit.handle(
    { tag: "MotionDetected", sensor: "binary_sensor.motion_living_room" },
  );

  expect(extractEvents(effect)).toEqual([
    { tag: "Activated", sensor: "binary_sensor.motion_living_room", at: expect.any(Number) },
  ]);
  expect(kit.state().mode).toBe("active");
});

test("timeout deactivates", async () => {
  const ha = mockHaActions();
  const kit = createAggregateTestKit(motionLightAggregate(ha));

  await kit.handle({ tag: "MotionDetected", sensor: "binary_sensor.motion_living_room" });
  const effect = await kit.handle({ tag: "TurnOffTimeout" });

  expect(extractEvents(effect)).toEqual([
    { tag: "Deactivated", reason: "timeout", at: expect.any(Number) },
  ]);
  expect(kit.state().mode).toBe("idle");
});
```

The full integration (bridge + runtime + real HA) is tested in development mode against the live HA instance.

## Addon Packaging (Production)

### File Structure

```
ts/
├── src/
│   ├── core/                   # existing TEOB core
│   ├── inmem/                  # existing in-memory runtime
│   ├── service/                # existing service lifecycle
│   ├── ha/                     # Home Assistant integration
│   │   ├── client.ts           # HaClient interface + WebSocket implementation
│   │   ├── config.ts           # HaConfig resolution (dev/prod)
│   │   ├── bridge.ts           # HaSubscription, HaBridge, event routing
│   │   ├── actions.ts          # HaActions helper
│   │   └── types.ts            # HaEntityState, HaEvent, HaTrigger, HaTarget
│   ├── automations/            # User-defined automation aggregates
│   │   ├── motion-light.ts
│   │   ├── climate-control.ts
│   │   └── index.ts            # buildAutomationRegistrations()
│   └── main.ts                 # Entry point: resolveConfig → buildService
├── addon/                      # HA addon packaging
│   ├── config.yaml
│   ├── Dockerfile
│   ├── run.sh
│   ├── icon.png
│   ├── logo.png
│   └── DOCS.md
├── test/
├── package.json
└── tsconfig.json
```

### addon/config.yaml

```yaml
name: "TEOB Automations"
description: "Event-sourced automation engine powered by TEOB aggregates"
version: "0.1.0"
slug: "teob-automations"
arch:
  - amd64
  - aarch64
homeassistant_api: true
ingress: true
ingress_port: 8099
ports:
  9095/tcp: null           # probe server, internal only
map:
  - config:ro              # read HA config if needed
  - share:rw               # persist journal snapshots
options:
  log_level: "info"
schema:
  log_level: "list(debug|info|warn|error)"
```

### addon/Dockerfile

```dockerfile
ARG BUILD_FROM
FROM ${BUILD_FROM}

RUN apk add --no-cache nodejs npm

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY dist/ ./dist/

COPY addon/run.sh /run.sh
RUN chmod a+x /run.sh

CMD [ "/run.sh" ]
```

### addon/run.sh

```bash
#!/usr/bin/with-contenv bashio

export HA_MODE="production"
export LOG_LEVEL="$(bashio::config 'log_level')"

bashio::log.info "Starting TEOB automation engine..."
exec node /app/dist/main.js
```

## WebSocket Protocol

The HA WebSocket API is message-based with incrementing IDs. Key message flows used by the client:

### Authentication

```
Client → { "type": "auth", "access_token": "<token>" }
Server → { "type": "auth_ok" }
```

### Subscribe to Events

```
Client → { "id": 1, "type": "subscribe_events", "event_type": "state_changed" }
Server → { "id": 1, "type": "result", "success": true }
Server → { "id": 1, "type": "event", "event": { ... } }   # repeated
```

### Subscribe to Trigger

```
Client → { "id": 2, "type": "subscribe_trigger", "trigger": { "platform": "state", "entity_id": "binary_sensor.motion_hall" } }
Server → { "id": 2, "type": "result", "success": true }
Server → { "id": 2, "type": "event", "event": { ... } }
```

### Call Service

```
Client → { "id": 3, "type": "call_service", "domain": "light", "service": "turn_on",
           "service_data": { "brightness": 255 }, "target": { "entity_id": "light.living_room" } }
Server → { "id": 3, "type": "result", "success": true }
```

### Get States

```
Client → { "id": 4, "type": "get_states" }
Server → { "id": 4, "type": "result", "success": true, "result": [ { "entity_id": "...", ... } ] }
```

## Implementation Order

1. **`ha/types.ts`** — HA domain types (`HaEntityState`, `HaEvent`, `HaTrigger`, `HaTarget`).
2. **`ha/client.ts`** — `HaClient` over raw WebSocket with auto-reconnect. Dev mode (url+token) and prod mode (supervisor).
3. **`ha/actions.ts`** — `HaActions` wrapping `HaClient.callService` into `() => Promise<void>` for `Effect.Run`.
4. **`ha/bridge.ts`** — `HaSubscription`, `HaBridge`, state cache, event→command routing.
5. **`ha/config.ts`** — `resolveHaConfig()` from env vars / `/data/options.json`.
6. **`main.ts`** — `ServiceTemplate` wiring, entry point.
7. **`automations/`** — First real automation aggregate.
8. **`addon/`** — Dockerfile, config.yaml, run.sh.
9. **Tests** — Unit tests for aggregates, integration test against live HA in dev mode.
