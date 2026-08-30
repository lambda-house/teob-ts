import { quickstart, aggregate } from "@lambda-house/teob-ts/quickstart";
import { persist, reply } from "@lambda-house/teob-ts/core";

// Define your first aggregate here, then add more in src/aggregates/

type Command = { tag: "Create" } | { tag: "GetStatus" };
type Event = { tag: "Created" };
type Reply = { tag: "Status"; created: boolean };
type State = { created: boolean };

const example = aggregate<Command, Event, State, Reply>({
  category: "example",
  initialState: () => ({ created: false }),
  decide: async (state, command) => {
    switch (command.tag) {
      case "Create":
        return persist({ tag: "Created" });
      case "GetStatus":
        return reply({ tag: "Status", created: state.created });
    }
  },
  apply: (state, event) => {
    switch (event.tag) {
      case "Created":
        return { created: true };
    }
  },
});

quickstart({ aggregates: [example], port: 3000 });
