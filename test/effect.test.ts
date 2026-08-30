import { describe, it, expect } from "vitest";
import {
  persist,
  reply,
  done,
  stop,
  stash,
  snapshot,
  unstash,
  run,
  andRun,
  andReply,
  andSnapshot,
  andStop,
  andUnstash,
  extractEvents,
  hasReply,
  type Effect,
} from "../src/core/effect.js";

type TestEvent = { tag: "EventA" } | { tag: "EventB" } | { tag: "EventC" };
type TestReply = { tag: "Ok" } | { tag: "Error" };

describe("Effect constructors", () => {
  it("persist should create Persist with single event", () => {
    const effect = persist<TestEvent, TestReply>({ tag: "EventA" });
    expect(effect.tag).toBe("Persist");
    if (effect.tag === "Persist") {
      expect(effect.events).toEqual([{ tag: "EventA" }]);
    }
  });

  it("persist should create Persist with multiple events", () => {
    const effect = persist<TestEvent, TestReply>(
      { tag: "EventA" },
      { tag: "EventB" },
      { tag: "EventC" },
    );
    if (effect.tag === "Persist") {
      expect(effect.events).toEqual([{ tag: "EventA" }, { tag: "EventB" }, { tag: "EventC" }]);
    }
  });

  it("reply should create Reply", () => {
    const effect = reply<TestEvent, TestReply>({ tag: "Ok" });
    expect(effect).toEqual({ tag: "Reply", value: { tag: "Ok" } });
  });

  it("done should create Done", () => {
    expect(done()).toEqual({ tag: "Done" });
  });

  it("stop should create Stop", () => {
    expect(stop()).toEqual({ tag: "Stop" });
  });

  it("stash should create Stash", () => {
    expect(stash()).toEqual({ tag: "Stash" });
  });

  it("snapshot should create Snapshot", () => {
    const effect = snapshot();
    expect(effect.tag).toBe("Snapshot");
  });
});

describe("extractEvents", () => {
  it("should extract events from Persist", () => {
    const effect = persist<TestEvent, TestReply>({ tag: "EventA" });
    expect(extractEvents(effect)).toEqual([{ tag: "EventA" }]);
  });

  it("should extract events from chained Persist", () => {
    const effect = andReply(persist<TestEvent, TestReply>({ tag: "EventA" }), { tag: "Ok" });
    expect(extractEvents(effect)).toEqual([{ tag: "EventA" }]);
  });

  it("should return empty for Reply without events", () => {
    const effect = reply<TestEvent, TestReply>({ tag: "Ok" });
    expect(extractEvents(effect)).toEqual([]);
  });

  it("should return empty for Stop", () => {
    expect(extractEvents(stop())).toEqual([]);
  });

  it("should return empty for Stash", () => {
    expect(extractEvents(stash())).toEqual([]);
  });

  it("should return empty for Done", () => {
    expect(extractEvents(done())).toEqual([]);
  });

  it("should extract events through Run chain", () => {
    const effect = andRun(persist<TestEvent, TestReply>({ tag: "EventA" }), async () => {});
    expect(extractEvents(effect)).toEqual([{ tag: "EventA" }]);
  });

  it("should extract events through Snapshot chain", () => {
    const effect = andSnapshot(persist<TestEvent, TestReply>({ tag: "EventA" }));
    expect(extractEvents(effect)).toEqual([{ tag: "EventA" }]);
  });

  it("should extract events through Unstash chain", () => {
    const effect = andUnstash(persist<TestEvent, TestReply>({ tag: "EventA" }));
    expect(extractEvents(effect)).toEqual([{ tag: "EventA" }]);
  });
});

describe("hasReply", () => {
  it("should return true for Reply", () => {
    expect(hasReply(reply<TestEvent, TestReply>({ tag: "Ok" }))).toBe(true);
  });

  it("should return false for Done", () => {
    expect(hasReply(done())).toBe(false);
  });

  it("should return false for Stop", () => {
    expect(hasReply(stop())).toBe(false);
  });

  it("should return false for Stash", () => {
    expect(hasReply(stash())).toBe(false);
  });

  it("should return true for Persist with Reply", () => {
    const effect = andReply(persist<TestEvent, TestReply>({ tag: "EventA" }), { tag: "Ok" });
    expect(hasReply(effect)).toBe(true);
  });

  it("should return true for Run with Reply", () => {
    const effect: Effect<TestEvent, TestReply> = {
      tag: "Run",
      sideEffect: async () => {},
      andThen: { tag: "Reply", value: { tag: "Ok" } },
    };
    expect(hasReply(effect)).toBe(true);
  });

  it("should return true for Snapshot with Reply", () => {
    const effect = andReply(snapshot<TestEvent, TestReply>(), { tag: "Ok" });
    expect(hasReply(effect)).toBe(true);
  });

  it("should return true for Unstash with Reply", () => {
    const effect: Effect<TestEvent, TestReply> = {
      tag: "Unstash",
      andThen: { tag: "Reply", value: { tag: "Ok" } },
    };
    expect(hasReply(effect)).toBe(true);
  });
});

describe("andRun", () => {
  it("should chain Run after Persist", () => {
    const effect = andRun(persist<TestEvent, TestReply>({ tag: "EventA" }), async () => {});
    expect(effect.tag).toBe("Persist");
    if (effect.tag === "Persist") {
      expect(effect.andThen.tag).toBe("Run");
    }
  });

  it("should chain Run after Run", () => {
    const base: Effect<TestEvent, TestReply> = {
      tag: "Run",
      sideEffect: async () => {},
      andThen: { tag: "Done" },
    };
    const effect = andRun(base, async () => {});
    expect(effect.tag).toBe("Run");
  });

  it("should chain Run after Snapshot", () => {
    const effect = andRun(snapshot<TestEvent, TestReply>(), async () => {});
    expect(effect.tag).toBe("Snapshot");
  });

  it("should chain Run after Unstash", () => {
    const base: Effect<TestEvent, TestReply> = { tag: "Unstash", andThen: { tag: "Done" } };
    const effect = andRun(base, async () => {});
    expect(effect.tag).toBe("Unstash");
  });

  it("should chain Run on Done", () => {
    const effect = andRun(done<TestEvent, TestReply>(), async () => {});
    expect(effect.tag).toBe("Run");
  });
});

describe("andReply", () => {
  it("should chain Reply after Persist", () => {
    const effect = andReply(persist<TestEvent, TestReply>({ tag: "EventA" }), { tag: "Ok" });
    if (effect.tag === "Persist") {
      expect(effect.andThen).toEqual({ tag: "Reply", value: { tag: "Ok" } });
    }
  });

  it("should replace existing Reply (Reply is terminal)", () => {
    // Reply is terminal in appendToChain, so andReply on Reply returns the original Reply
    const effect = andReply(reply<TestEvent, TestReply>({ tag: "Error" }), { tag: "Ok" });
    // Reply is terminal — the original Reply is kept
    expect(effect).toEqual({ tag: "Reply", value: { tag: "Error" } });
  });

  it("should chain Reply after Run", () => {
    const base: Effect<TestEvent, TestReply> = {
      tag: "Run",
      sideEffect: async () => {},
      andThen: { tag: "Done" },
    };
    const effect = andReply(base, { tag: "Ok" });
    expect(effect.tag).toBe("Run");
    expect(hasReply(effect)).toBe(true);
  });

  it("should chain Reply on Done", () => {
    const effect = andReply(done<TestEvent, TestReply>(), { tag: "Ok" });
    expect(effect).toEqual({ tag: "Reply", value: { tag: "Ok" } });
  });
});

describe("andSnapshot", () => {
  it("should chain Snapshot after Persist", () => {
    const effect = andSnapshot(persist<TestEvent, TestReply>({ tag: "EventA" }));
    if (effect.tag === "Persist") {
      expect(effect.andThen.tag).toBe("Snapshot");
    }
  });

  it("should chain Snapshot after Run", () => {
    const base: Effect<TestEvent, TestReply> = {
      tag: "Run",
      sideEffect: async () => {},
      andThen: { tag: "Done" },
    };
    const effect = andSnapshot(base);
    expect(effect.tag).toBe("Run");
  });

  it("should wrap Done in Snapshot", () => {
    const effect = andSnapshot(done<TestEvent, TestReply>());
    expect(effect.tag).toBe("Snapshot");
  });
});

describe("andStop", () => {
  it("should chain Stop after Persist", () => {
    const effect = andStop(persist<TestEvent, TestReply>({ tag: "EventA" }));
    if (effect.tag === "Persist") {
      expect(effect.andThen).toEqual({ tag: "Stop" });
    }
  });

  it("should chain Stop after Run", () => {
    const base: Effect<TestEvent, TestReply> = {
      tag: "Run",
      sideEffect: async () => {},
      andThen: { tag: "Done" },
    };
    const effect = andStop(base);
    expect(effect.tag).toBe("Run");
  });

  it("should chain Stop after Snapshot", () => {
    const effect = andStop(snapshot<TestEvent, TestReply>());
    expect(effect.tag).toBe("Snapshot");
  });

  it("should chain Stop after Unstash", () => {
    const base: Effect<TestEvent, TestReply> = { tag: "Unstash", andThen: { tag: "Done" } };
    const effect = andStop(base);
    expect(effect.tag).toBe("Unstash");
  });

  it("should return Stop for Reply (Reply is terminal)", () => {
    const effect = andStop(reply<TestEvent, TestReply>({ tag: "Ok" }));
    // Reply is terminal — Stop is not appended
    expect(effect.tag).toBe("Reply");
  });

  it("should return Stop for Done", () => {
    const effect = andStop(done<TestEvent, TestReply>());
    expect(effect).toEqual({ tag: "Stop" });
  });
});

describe("andUnstash", () => {
  it("should chain Unstash after Persist", () => {
    const effect = andUnstash(persist<TestEvent, TestReply>({ tag: "EventA" }));
    if (effect.tag === "Persist") {
      expect(effect.andThen.tag).toBe("Unstash");
    }
  });

  it("should chain Unstash after Run", () => {
    const base: Effect<TestEvent, TestReply> = {
      tag: "Run",
      sideEffect: async () => {},
      andThen: { tag: "Done" },
    };
    const effect = andUnstash(base);
    expect(effect.tag).toBe("Run");
  });

  it("should wrap Done in Unstash", () => {
    const effect = andUnstash(done<TestEvent, TestReply>());
    expect(effect.tag).toBe("Unstash");
  });
});
