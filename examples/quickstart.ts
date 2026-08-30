/**
 * TEOB Quickstart — a running event-sourced HTTP API in ~30 lines.
 *
 * Run:  npx tsx examples/quickstart.ts
 * Try:  curl -X POST http://localhost:3000/api/counter/my-counter \
 *         -H 'Content-Type: application/json' \
 *         -d '{"tag":"Increment"}'
 */
import { aggregate, quickstart } from "../src/quickstart/index.js";
import { persist, reply } from "../src/core/effect.js";

type Command = { tag: "Increment" } | { tag: "Decrement" } | { tag: "GetCount" };
type Event = { tag: "Incremented" } | { tag: "Decremented" };
type Reply = { tag: "Count"; count: number };
type State = { count: number };

const counter = aggregate<Command, Event, State, Reply>({
  category: "counter",
  initialState: () => ({ count: 0 }),
  decide: async (state, command) => {
    switch (command.tag) {
      case "Increment":
        return persist({ tag: "Incremented" });
      case "Decrement":
        return persist({ tag: "Decremented" });
      case "GetCount":
        return reply({ tag: "Count", count: state.count });
    }
  },
  apply: (state, event) => {
    switch (event.tag) {
      case "Incremented":
        return { count: state.count + 1 };
      case "Decremented":
        return { count: state.count - 1 };
    }
  },
});

quickstart({ aggregates: [counter], port: 3000 });
