/**
 * Tests for SignupFlowAggregate.
 *
 * Mirrors the Scala SignupFlowAggregateSpec — verifies the Petri-net flow
 * schema and aggregate logic using AggregateTestKit.
 */

import { describe, it, expect } from "vitest";
import { createAggregateTestKit } from "../src/testing/aggregate-testkit.js";
import { categoryTypes } from "../src/core/effect-control.js";
import { createSingleRuntime } from "../src/inmem/runtime.js";
import { tagCodec, objectCodec } from "../src/core/codec.js";
import { EntityId } from "../src/core/types.js";
import { validate, compileSchema, compileSchemaOrFail, toDotString } from "../src/petrinet/index.js";
import type { FlowCommand, FlowReply, FlowState, FlowEvent } from "../src/petrinet/index.js";
import {
  signupFlowSchema,
  signupRequested,
  SignupFlowCategory,
  withEmailCheck,
} from "./example/signup-flow.js";

// Happy path: all emails available
const happyAggregate = withEmailCheck(() => true);
const happyKit = createAggregateTestKit(happyAggregate);

// Rejecting: emails containing "taken" are unavailable
const rejectingAggregate = withEmailCheck((email) => !email.includes("taken"));

const flowCat = categoryTypes<FlowCommand, FlowReply>(SignupFlowCategory);

describe("SignupFlowAggregate", () => {
  describe("schema validation", () => {
    it("should compile without errors", () => {
      const result = compileSchema(signupFlowSchema, "SignupFlow");
      expect("flow" in result).toBe(true);
    });

    it("should have expected places", () => {
      const flow = compileSchemaOrFail(signupFlowSchema, "test");
      expect([...flow.places.keys()].sort()).toEqual(["Completed", "EmailChecked", "Pending", "Rejected"]);
    });

    it("should have expected transitions", () => {
      const flow = compileSchemaOrFail(signupFlowSchema, "test");
      expect([...flow.transitions.keys()].sort()).toEqual(["CreateAccount", "ValidateEmail"]);
    });

    it("should mark Pending as inbound place", () => {
      const flow = compileSchemaOrFail(signupFlowSchema, "test");
      expect(flow.places.get("Pending")!.type).toBe("Inbound");
    });

    it("should mark Completed and Rejected as outbound places", () => {
      const flow = compileSchemaOrFail(signupFlowSchema, "test");
      expect(flow.places.get("Completed")!.type).toBe("Outbound");
      expect(flow.places.get("Rejected")!.type).toBe("Outbound");
    });
  });

  describe("inbound token", () => {
    it("should produce TokenAdded event when signup request arrives", async () => {
      const { result } = await happyKit.run(happyKit.initialState, {
        tag: "InboundToken",
        token: signupRequested("user@example.com", "password123"),
        expectsRepliesAt: [],
        spanId: "test-span-1",
      });

      expect(result.events.length).toBeGreaterThan(0);
      expect(result.events[0].tag).toBe("TokenAdded");
    });

    it("should fire ValidateEmail transition when token is added to Pending", async () => {
      const { result } = await happyKit.run(happyKit.initialState, {
        tag: "InboundToken",
        token: signupRequested("user@example.com", "password123"),
        expectsRepliesAt: [],
        spanId: "test-span-2",
      });

      expect(result.events.length).toBeGreaterThanOrEqual(2);
      expect(result.events.some((e) => e.tag === "TransitionFired")).toBe(true);

      const fired = result.events.find((e) => e.tag === "TransitionFired")!;
      expect(fired.tag === "TransitionFired" && fired.transitionId).toBe("ValidateEmail");
    });
  });

  describe("state evolution", () => {
    it("should record token history when token is added", async () => {
      const { newState } = await happyKit.runAndApply(happyKit.initialState, {
        tag: "InboundToken",
        token: signupRequested("user@example.com", "password123"),
        expectsRepliesAt: [],
        spanId: "test-span-3",
      });

      expect(newState.tokenHistory.get("test-span-3")).toBe("Pending");
    });

    it("should consume token when transition fires", async () => {
      const { newState } = await happyKit.runAndApply(happyKit.initialState, {
        tag: "InboundToken",
        token: signupRequested("user@example.com", "password123"),
        expectsRepliesAt: [],
        spanId: "test-span-4",
      });

      // After transition fires, token is consumed from Pending
      expect(newState.flow.places.get("Pending")!.tokens).toHaveLength(0);

      // Transition should have consumed the token and be Ongoing
      const transition = newState.flow.transitions.get("ValidateEmail")!;
      expect(transition.state).toBe("Ongoing");
      expect(transition.consumed).toBeDefined();
    });
  });

  describe("GetFlowInstanceView", () => {
    it("should return current flow state", async () => {
      const { result } = await happyKit.run(happyKit.initialState, {
        tag: "GetFlowInstanceView",
      });

      expect(result.reply).toBeDefined();
      expect(result.reply!.tag).toBe("FlowInstanceView");

      const view = result.reply! as FlowReply & { tag: "FlowInstanceView" };
      expect(view.places.has("Pending")).toBe(true);
      expect(view.transitions.has("ValidateEmail")).toBe(true);
    });

    it("should show empty places initially", async () => {
      const { result } = await happyKit.run(happyKit.initialState, {
        tag: "GetFlowInstanceView",
      });

      const view = result.reply! as FlowReply & { tag: "FlowInstanceView" };
      for (const tokens of view.places.values()) {
        expect(tokens).toHaveLength(0);
      }
    });

    it("should show all transitions as NotStarted initially", async () => {
      const { result } = await happyKit.run(happyKit.initialState, {
        tag: "GetFlowInstanceView",
      });

      const view = result.reply! as FlowReply & { tag: "FlowInstanceView" };
      for (const state of view.transitions.values()) {
        expect(state).toBe("NotStarted");
      }
    });
  });

  describe("side effects", () => {
    it("should generate side effects for transition execution", async () => {
      const { result } = await happyKit.run(happyKit.initialState, {
        tag: "InboundToken",
        token: signupRequested("user@example.com", "password123"),
        expectsRepliesAt: [],
        spanId: "test-span-5",
      });

      expect(result.sideEffects.length).toBeGreaterThan(0);
    });

    it("should feed transition result back via tellSelf", async () => {
      const { result, record } = await happyKit.run(happyKit.initialState, {
        tag: "InboundToken",
        token: signupRequested("user@example.com", "password123"),
        expectsRepliesAt: [],
        spanId: "test-span-6",
      });

      // Execute the side effects (they call tellSelf)
      for (const sideEffect of result.sideEffects) {
        await sideEffect();
      }

      // Should have sent TransitionResult back to self
      expect(record.selfCommands.length).toBeGreaterThan(0);
      const transitionResult = record.selfCommands.find(
        (c) => (c as FlowCommand).tag === "TransitionResult",
      ) as FlowCommand | undefined;
      expect(transitionResult).toBeDefined();
      expect(transitionResult!.tag === "TransitionResult" && transitionResult!.transitionId).toBe("ValidateEmail");
    });
  });

  describe("DOT output", () => {
    it("should generate valid DOT string", () => {
      const flow = compileSchemaOrFail(signupFlowSchema, "SignupFlow");
      const dot = toDotString(flow);

      expect(dot).toContain("digraph");
      expect(dot).toContain("Pending");
      expect(dot).toContain("ValidateEmail");
      expect(dot).toContain("CreateAccount");
      expect(dot).toContain("Completed");
      expect(dot).toContain("Rejected");
    });
  });
});

describe("SignupFlowAggregate — runtime integration", () => {
  it("should complete happy path through EntityRuntime", async () => {
    const aggregate = withEmailCheck(() => true);
    const { runtime } = createSingleRuntime(aggregate, tagCodec(), objectCodec("FlowState"));
    await runtime.start();

    await runtime.tell(
      EntityId("signup-1"),
      {
        tag: "InboundToken",
        token: signupRequested("alice@example.com", "pass123"),
        expectsRepliesAt: [],
        spanId: "span-happy",
      } satisfies FlowCommand,
      flowCat,
    );

    await new Promise((r) => setTimeout(r, 200));

    const result = await runtime.ask(
      EntityId("signup-1"),
      { tag: "GetFlowInstanceView" } satisfies FlowCommand,
      flowCat,
    );

    expect(result.ok).toBe(true);
    if (result.ok && result.value.reply) {
      const view = result.value.reply as FlowReply & { tag: "FlowInstanceView" };
      expect(view.transitions.get("ValidateEmail")).toBe("Completed");
      expect(view.transitions.get("CreateAccount")).toBe("Completed");
      const completedTokens = view.places.get("Completed") ?? [];
      expect(completedTokens.length).toBeGreaterThanOrEqual(1);
    }

    await runtime.shutdown();
  });

  it("should route to Rejected on email taken", async () => {
    const aggregate = withEmailCheck((email) => !email.includes("taken"));
    const { runtime } = createSingleRuntime(aggregate, tagCodec(), objectCodec("FlowState"));
    await runtime.start();

    await runtime.tell(
      EntityId("signup-2"),
      {
        tag: "InboundToken",
        token: signupRequested("taken@example.com", "pass"),
        expectsRepliesAt: [],
        spanId: "span-reject",
      } satisfies FlowCommand,
      flowCat,
    );

    await new Promise((r) => setTimeout(r, 200));

    const result = await runtime.ask(
      EntityId("signup-2"),
      { tag: "GetFlowInstanceView" } satisfies FlowCommand,
      flowCat,
    );

    expect(result.ok).toBe(true);
    if (result.ok && result.value.reply) {
      const view = result.value.reply as FlowReply & { tag: "FlowInstanceView" };
      expect(view.transitions.get("ValidateEmail")).toBe("Completed");
      // CreateAccount should NOT have fired
      expect(view.transitions.get("CreateAccount")).toBe("NotStarted");
      const rejectedTokens = view.places.get("Rejected") ?? [];
      expect(rejectedTokens.length).toBeGreaterThanOrEqual(1);
    }

    await runtime.shutdown();
  });

  it("should handle multiple independent signup flows", async () => {
    const aggregate = withEmailCheck(() => true);
    const { runtime } = createSingleRuntime(aggregate, tagCodec(), objectCodec("FlowState"));
    await runtime.start();

    // Start 3 signups concurrently
    await Promise.all(
      ["alice", "bob", "carol"].map((name) =>
        runtime.tell(
          EntityId(`signup-${name}`),
          {
            tag: "InboundToken",
            token: signupRequested(`${name}@example.com`, "pass"),
            expectsRepliesAt: [],
            spanId: `span-${name}`,
          } satisfies FlowCommand,
          flowCat,
        ),
      ),
    );

    await new Promise((r) => setTimeout(r, 300));

    // All should have completed
    for (const name of ["alice", "bob", "carol"]) {
      const result = await runtime.ask(
        EntityId(`signup-${name}`),
        { tag: "GetFlowInstanceView" } satisfies FlowCommand,
        flowCat,
      );
      expect(result.ok).toBe(true);
      if (result.ok && result.value.reply) {
        const view = result.value.reply as FlowReply & { tag: "FlowInstanceView" };
        expect(view.transitions.get("ValidateEmail")).toBe("Completed");
        expect(view.transitions.get("CreateAccount")).toBe("Completed");
      }
    }

    await runtime.shutdown();
  });
});

describe("SignupFlowAggregate — deferred reply", () => {
  it("should return OutboundTokens via deferred reply on happy path", async () => {
    const aggregate = withEmailCheck(() => true);
    const { runtime } = createSingleRuntime(aggregate, tagCodec(), objectCodec("FlowState"));
    await runtime.start();

    // Use ask() with expectsRepliesAt — the reply should arrive when the flow completes
    const result = await runtime.ask(
      EntityId("deferred-happy"),
      {
        tag: "InboundToken",
        token: signupRequested("deferred@example.com", "pass123"),
        expectsRepliesAt: ["Completed", "Rejected"],
        spanId: "span-deferred-happy",
      } satisfies FlowCommand,
      flowCat,
    );

    // The ask() should resolve with OutboundTokens (not undefined)
    expect(result.ok).toBe(true);
    if (result.ok && result.value.reply) {
      const reply = result.value.reply as FlowReply;
      expect(reply.tag).toBe("OutboundTokens");
      if (reply.tag === "OutboundTokens") {
        expect(reply.spanId).toBe("span-deferred-happy");
        const completedTokens = reply.tokens.get("Completed") ?? [];
        expect(completedTokens.length).toBeGreaterThanOrEqual(1);
        expect(completedTokens[0].tag).toBe("AccountCreated");
      }
    }

    await runtime.shutdown();
  });

  it("should return OutboundTokens at Rejected via deferred reply", async () => {
    const aggregate = withEmailCheck((email) => !email.includes("taken"));
    const { runtime } = createSingleRuntime(aggregate, tagCodec(), objectCodec("FlowState"));
    await runtime.start();

    const result = await runtime.ask(
      EntityId("deferred-reject"),
      {
        tag: "InboundToken",
        token: signupRequested("taken@example.com", "pass"),
        expectsRepliesAt: ["Completed", "Rejected"],
        spanId: "span-deferred-reject",
      } satisfies FlowCommand,
      flowCat,
    );

    expect(result.ok).toBe(true);
    if (result.ok && result.value.reply) {
      const reply = result.value.reply as FlowReply;
      expect(reply.tag).toBe("OutboundTokens");
      if (reply.tag === "OutboundTokens") {
        expect(reply.spanId).toBe("span-deferred-reject");
        const rejectedTokens = reply.tokens.get("Rejected") ?? [];
        expect(rejectedTokens.length).toBeGreaterThanOrEqual(1);
        expect(rejectedTokens[0].tag).toBe("EmailTaken");
      }
    }

    await runtime.shutdown();
  });

  it("should handle multiple concurrent deferred flows", async () => {
    const aggregate = withEmailCheck(() => true);
    const { runtime } = createSingleRuntime(aggregate, tagCodec(), objectCodec("FlowState"));
    await runtime.start();

    // Start 3 flows concurrently via ask() with deferred replies
    const results = await Promise.all(
      ["alice", "bob", "carol"].map((name) =>
        runtime.ask(
          EntityId(`deferred-${name}`),
          {
            tag: "InboundToken",
            token: signupRequested(`${name}@example.com`, "pass"),
            expectsRepliesAt: ["Completed"],
            spanId: `span-${name}`,
          } satisfies FlowCommand,
          flowCat,
        ),
      ),
    );

    for (const result of results) {
      expect(result.ok).toBe(true);
      if (result.ok && result.value.reply) {
        const reply = result.value.reply as FlowReply;
        expect(reply.tag).toBe("OutboundTokens");
      }
    }

    await runtime.shutdown();
  });
});
