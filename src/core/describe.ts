// describe.ts — Runtime discovery of aggregate models via codec manifests

import type { Aggregate } from "./aggregate.js";
import type { Codec } from "./codec.js";

/** JSON-serializable description of an aggregate's model. */
export interface AggregateDescription {
  category: string;
  events: readonly string[];
  state: readonly string[];
  commands?: readonly string[];
  replies?: readonly string[];
  invariants?: readonly string[];
  snapshotEvery: number;
}

/** Options for describeAggregate. All codecs with manifests contribute to the description. */
export interface DescribeOptions<Command, Reply, Event, State> {
  aggregate: Aggregate<Command, Reply, Event, State>;
  eventCodec: Codec<Event>;
  stateCodec: Codec<State>;
  commandCodec?: Codec<Command>;
  replyCodec?: Codec<Reply>;
}

/**
 * Extract a JSON-serializable description from an aggregate and its codecs.
 * Requires codecs created with manifest tags (e.g. `tagCodec<E>("Created", "Deleted")`).
 */
export function describeAggregate<Command, Reply, Event, State>(
  opts: DescribeOptions<Command, Reply, Event, State>,
): AggregateDescription {
  const { aggregate, eventCodec, stateCodec, commandCodec, replyCodec } = opts;

  return {
    category: aggregate.category,
    events: eventCodec.manifests ?? [],
    state: stateCodec.manifests ?? [],
    ...(commandCodec?.manifests ? { commands: commandCodec.manifests } : {}),
    ...(replyCodec?.manifests ? { replies: replyCodec.manifests } : {}),
    ...(aggregate.invariants?.length
      ? { invariants: aggregate.invariants.map((i) => i.name) }
      : {}),
    snapshotEvery: aggregate.snapshotEvery ?? 100,
  };
}
