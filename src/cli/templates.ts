// CLI templates for code generation

/** Convert kebab-case or plain string to PascalCase */
export function pascalCase(s: string): string {
  return s
    .split(/[-_\s]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
}

/** Convert kebab-case or plain string to camelCase */
export function camelCase(s: string): string {
  const p = pascalCase(s);
  return p.charAt(0).toLowerCase() + p.slice(1);
}

/** Convert to kebab-case */
export function kebabCase(s: string): string {
  return s
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .toLowerCase();
}

export function aggregateTemplate(name: string): string {
  const pascal = pascalCase(name);
  const camel = camelCase(name);
  const kebab = kebabCase(name);

  return `import { CategoryId, type EntityId } from "@lambda-house/teob-ts/core";
import type { Aggregate } from "@lambda-house/teob-ts/core";
import type { Effect } from "@lambda-house/teob-ts/core";
import type { EffectControl } from "@lambda-house/teob-ts/core";
import { persist, reply } from "@lambda-house/teob-ts/core";
import { categoryTypes } from "@lambda-house/teob-ts/core";
import { tagCodec, objectCodec } from "@lambda-house/teob-ts/core";

// Commands
export type ${pascal}Command =
  | { tag: "Create" }; // TODO: add fields

// Events
export type ${pascal}Event =
  | { tag: "${pascal}Created" }; // TODO: add fields

// State
export interface ${pascal}State {
  created: boolean;
  // TODO: add state fields
}

// Reply
export type ${pascal}Reply =
  | { tag: "Ok" }
  | { tag: "Rejected"; reason: string };

// Category registration (for cross-entity communication)
export const ${camel}Category = categoryTypes<${pascal}Command, ${pascal}Reply>(
  CategoryId("${kebab}"),
);

// Aggregate
export const ${camel}Aggregate: Aggregate<
  ${pascal}Command,
  ${pascal}Reply,
  ${pascal}Event,
  ${pascal}State
> = {
  category: CategoryId("${kebab}"),

  initial(_id: EntityId): ${pascal}State {
    return { created: false };
  },

  async decide(
    state: ${pascal}State,
    command: ${pascal}Command,
    _ctx: EffectControl<${pascal}Command, ${pascal}Reply>,
  ): Promise<Effect<${pascal}Event, ${pascal}Reply>> {
    switch (command.tag) {
      case "Create":
        if (state.created) {
          return reply({ tag: "Rejected", reason: "Already created" });
        }
        return persist({ tag: "${pascal}Created" });
    }
  },

  apply(state: ${pascal}State, event: ${pascal}Event): ${pascal}State {
    switch (event.tag) {
      case "${pascal}Created":
        return { ...state, created: true };
    }
  },
};

// Codecs
export const ${camel}EventCodec = tagCodec<${pascal}Event>("${pascal}Created");
export const ${camel}StateCodec = objectCodec<${pascal}State>("${pascal}State");
export const ${camel}CommandCodec = tagCodec<${pascal}Command>("Create");
export const ${camel}ReplyCodec = tagCodec<${pascal}Reply>("Ok", "Rejected");
`;
}

export function projectionTemplate(name: string): string {
  const pascal = pascalCase(name);
  const camel = camelCase(name);
  const kebab = kebabCase(name);

  return `import { projection } from "@lambda-house/teob-ts/projection";

// TODO: import your event types
// import type { MyEvent } from "../aggregates/my-aggregate.js";

// View type
export interface ${pascal}View {
  // TODO: add view fields
}

export const ${camel}Projection = projection({
  projectionId: "${kebab}",
  category: "TODO", // TODO: set source category

  initialState: (): ${pascal}View => ({
    // TODO: set initial view state
  }),

  evolve: (view: ${pascal}View, event: any, entityId): ${pascal}View => {
    switch (event.tag) {
      // TODO: handle events
      // case "SomethingHappened":
      //   return { ...view, field: event.value };
      default:
        return view;
    }
  },
});
`;
}

export function flowTemplate(name: string): string {
  const pascal = pascalCase(name);
  const camel = camelCase(name);
  const kebab = kebabCase(name);

  return `import { CategoryId } from "@lambda-house/teob-ts/core";
import { tagCodec, objectCodec } from "@lambda-house/teob-ts/core";

// TODO: Define your flow places, transitions, and commands
// See src/petrinet/ for FlowSchema and flowAggregate APIs

// Places (states in the flow)
export type ${pascal}Place = "initial" | "completed"; // TODO: add places

// Flow category
export const ${camel}Category = CategoryId("${kebab}");

// Codecs
// export const ${camel}EventCodec = tagCodec<${pascal}Event>(...);
// export const ${camel}StateCodec = objectCodec<FlowState<${pascal}Place>>("${pascal}FlowState");
`;
}

export function initTemplate(): {
  serviceTs: string;
  tsconfigJson: string;
  packageJsonPatch: Record<string, unknown>;
} {
  return {
    serviceTs: `import { quickstart, aggregate } from "@lambda-house/teob-ts/quickstart";
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
`,
    tsconfigJson: `{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "declaration": true,
    "resolveJsonModule": true
  },
  "include": ["src"]
}
`,
    packageJsonPatch: {
      type: "module",
      scripts: {
        dev: "tsx watch src/service.ts",
        build: "tsc",
        start: "node dist/service.js",
      },
      dependencies: {
        "@lambda-house/teob-ts": "latest",
      },
      devDependencies: {
        tsx: "^4.19.0",
        typescript: "^5.7.0",
        vitest: "^3.0.0",
      },
    },
  };
}
