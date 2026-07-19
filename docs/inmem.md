# teob-inmem

In-memory runtime and journal for the TEOB framework. Provides a fully functional `EntityRuntime` backed by in-process state — ideal for testing, development, and single-process deployments.

**Depends on:** [teob-core](core.md)

```typescript
import { createSingleRuntime, createInMemoryRuntime, registration } from "teob-ts/inmem";
```

```
src/inmem/
├── runtime.ts        — createSingleRuntime, createInMemoryRuntime
├── entity-runner.ts  — actor lifecycle, mailbox, recovery
└── journal.ts        — in-memory event/snapshot storage
```

---

## Architecture

```mermaid
graph TB
    subgraph "EntityRuntime"
        direction LR
        MOD1[Module: counter]
        MOD2[Module: order]
    end

    subgraph "Module (per category)"
        direction LR
        E1[Entity A<br/>Mailbox + State]
        E2[Entity B<br/>Mailbox + State]
    end

    subgraph "Entity Actor Loop"
        direction TB
        MB[Mailbox] --> RECV[Dequeue Message]
        RECV --> HANDLE[decide command]
        HANDLE --> EFFECT[Execute Effect]
        EFFECT --> PERSIST[Persist Events]
        PERSIST --> APPLY[Apply to State]
        APPLY --> SNAP{Snapshot<br/>threshold?}
        SNAP -->|yes| SAVE[Save Snapshot]
        SNAP -->|no| MB
        SAVE --> MB
    end

    J[(In-Memory Journal<br/>Map-based storage)]
    PERSIST --> J
    SAVE --> J
```

Each entity is an independent actor with its own mailbox queue. Entities are created lazily on first command.

---

## API

### createSingleRuntime

Convenience for a single aggregate:

```typescript
import { createSingleRuntime } from "teob-ts/inmem";
import { tagCodec, objectCodec } from "teob-ts/core";

const { runtime, journal } = createSingleRuntime(
  counterAggregate,
  tagCodec<CounterEvent>(),
  objectCodec<CounterState>("CounterState"),
);

await runtime.start();   // entities start lazily — this is a no-op
// ... use runtime.tell() and runtime.ask()
await runtime.shutdown(); // stops all entity actors
```

### createInMemoryRuntime

Multiple aggregates in a shared runtime (enables cross-entity communication):

```typescript
import { createInMemoryRuntime, registration } from "teob-ts/inmem";

const { runtime, journal } = createInMemoryRuntime([
  registration(counterAggregate, counterEventCodec, counterStateCodec),
  registration(orderAggregate, orderEventCodec, orderStateCodec),
]);
```

### AggregateRegistration

Packages an aggregate with its codecs:

```typescript
interface AggregateRegistration<Command, Reply, Event, State> {
  aggregate: Aggregate<Command, Reply, Event, State>;
  eventCodec: Codec<Event>;
  stateCodec: Codec<State>;
}

// Helper
registration(aggregate, eventCodec, stateCodec)
```

---

## Entity Lifecycle

```mermaid
stateDiagram-v2
    [*] --> Created: first command arrives
    Created --> Recovering: load snapshot + replay events
    Recovering --> Ready: onRecoveryComplete()
    Ready --> Processing: dequeue message
    Processing --> Ready: effect executed + events applied
    Processing --> Stopped: Effect.Stop
    Ready --> Stopped: Stop message
    Stopped --> [*]
```

1. **Creation** — First `tell`/`ask` for an entity ID spawns the actor
2. **Recovery** — Load latest snapshot from journal, replay events since snapshot, call `onRecoveryComplete` if defined
3. **Message loop** — Dequeue from mailbox -> `decide(state, command, ctx)` -> execute effect chain -> persist events -> `apply(state, event)` -> auto-snapshot if threshold reached
4. **Timers** — Managed via `setTimeout`/`setInterval`, automatically cancelled on entity stop
5. **Shutdown** — Send `Stop` to all actors, await completion

---

## tell vs ask

```mermaid
sequenceDiagram
    participant C as Caller
    participant RT as Runtime
    participant E as Entity

    Note over C,E: tell — fire-and-forget
    C->>RT: tell(entityId, command, category)
    RT->>E: enqueue Tell message
    Note over C: returns immediately

    Note over C,E: ask — request-reply
    C->>RT: ask(entityId, command, category)
    RT->>E: enqueue Ask message + resolve callback
    E->>E: decide -> Effect with Reply
    E-->>RT: resolve(reply)
    RT-->>C: Either<ReplyError, Reply>
    Note over C: 30s timeout
```

- `tell` returns `Promise<void>` — the command is enqueued but the caller does not wait for processing
- `ask` returns `Promise<Either<ReplyError, R>>` — the caller awaits the reply with a 30-second timeout
- If the aggregate returns `ReplyDeferred(deferred)` instead of `Reply(value)`, the `ask()` stays open across multiple command processings until `deferred.complete(value)` is called — the caller sees the same `Either<ReplyError, R>` interface regardless

---

## In-Memory Journal

Simple `Map`-based storage:

```typescript
interface Journal {
  persistEvents(persistenceId: string, events: JournalEntry[]): Promise<void>;
  loadEvents(persistenceId: string, fromSeqNr: number): Promise<JournalEntry[]>;
  persistSnapshot(persistenceId: string, snapshot: SnapshotEntry): Promise<void>;
  loadSnapshot(persistenceId: string): Promise<SnapshotEntry | undefined>;
}
```

- Events stored as arrays keyed by `persistenceId`
- Snapshots stored as single entries per `persistenceId` (latest wins)
- No durability — data is lost on process exit
- Returned by `createSingleRuntime` / `createInMemoryRuntime` for inspection in tests
