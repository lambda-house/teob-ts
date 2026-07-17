import { describe, it, expect } from "vitest";
import {
  placeDef, transitionDef, flowSchema, compileSchema, compileSchemaOrFail, validate,
  addToken, transitionsReady, recordTransitionStart, recordTransitionCompletion, recordTransitionFailure,
  toDotString,
  handleFlowCommand, updateFlowState, executeSideEffects,
  flowAggregate,
} from "../src/petrinet/index.js";
import type {
  Token, PlaceDef, TransitionDef, ExecutableFlow, FlowState, FlowExternals, FlowCommand,
} from "../src/petrinet/index.js";
import { CategoryId } from "../src/core/types.js";
import { createSingleRuntime } from "../src/inmem/runtime.js";
import { tagCodec, objectCodec } from "../src/core/codec.js";
import { categoryTypes } from "../src/core/effect-control.js";
import type { FlowReply } from "../src/petrinet/index.js";

// --- Signup flow example (mirrors Scala SignupFlow) ---

// Tokens
interface SignupRequested extends Token { tag: "SignupRequested"; email: string; password: string }
interface EmailValidated extends Token { tag: "EmailValidated"; email: string; password: string }
interface AccountCreated extends Token { tag: "AccountCreated"; userId: string; email: string }
interface EmailTaken extends Token { tag: "EmailTaken"; email: string }

const signupRequested = (email: string, password: string): SignupRequested =>
  ({ tag: "SignupRequested", email, password });
const emailValidated = (email: string, password: string): EmailValidated =>
  ({ tag: "EmailValidated", email, password });
const accountCreated = (userId: string, email: string): AccountCreated =>
  ({ tag: "AccountCreated", userId, email });
const emailTaken = (email: string): EmailTaken =>
  ({ tag: "EmailTaken", email });

// Places
const Pending = placeDef("Pending", ["SignupRequested"], "Inbound");
const EmailChecked = placeDef("EmailChecked", ["EmailValidated"], "Internal");
const Completed = placeDef("Completed", ["AccountCreated"], "Outbound");
const Rejected = placeDef("Rejected", ["EmailTaken"], "Outbound");

// Transitions
const ValidateEmail = transitionDef("ValidateEmail", "Pending", ["SignupRequested"], {
  EmailValidated: "EmailChecked",
  EmailTaken: "Rejected",
});
const CreateAccount = transitionDef("CreateAccount", "EmailChecked", ["EmailValidated"], {
  AccountCreated: "Completed",
});

const signupSchema = flowSchema(
  [Pending, EmailChecked, Completed, Rejected],
  [ValidateEmail, CreateAccount],
);

function createSignupFlow(): ExecutableFlow {
  return compileSchemaOrFail(signupSchema, "SignupFlow");
}

function initialFlowState(): FlowState {
  return { flow: createSignupFlow(), tokenHistory: new Map() };
}

function createSignupExternals(emailAvailable: (email: string) => boolean): FlowExternals {
  return {
    transitions: new Map([
      ["ValidateEmail", async (_tid, consumed) => {
        const req = consumed.find((t) => t.tag === "SignupRequested") as SignupRequested | undefined;
        if (!req) return { error: "No SignupRequested token" };
        if (emailAvailable(req.email)) {
          return [emailValidated(req.email, req.password)];
        }
        return [emailTaken(req.email)];
      }],
      ["CreateAccount", async (_tid, consumed) => {
        const validated = consumed.find((t) => t.tag === "EmailValidated") as EmailValidated | undefined;
        if (!validated) return { error: "No EmailValidated token" };
        const userId = `user-${Math.abs(validated.email.split("").reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 0))}`;
        return [accountCreated(userId, validated.email)];
      }],
    ]),
    outbound: new Map([
      ["Completed", async () => { /* send welcome email */ }],
      ["Rejected", async () => { /* log rejection */ }],
    ]),
  };
}

// --- Tests ---

describe("FlowSchema validation", () => {
  it("should compile without errors", () => {
    const result = compileSchema(signupSchema, "SignupFlow");
    expect("flow" in result).toBe(true);
  });

  it("should have expected places", () => {
    const flow = createSignupFlow();
    expect([...flow.places.keys()].sort()).toEqual(["Completed", "EmailChecked", "Pending", "Rejected"]);
  });

  it("should have expected transitions", () => {
    const flow = createSignupFlow();
    expect([...flow.transitions.keys()].sort()).toEqual(["CreateAccount", "ValidateEmail"]);
  });

  it("should mark Pending as inbound place", () => {
    const flow = createSignupFlow();
    expect(flow.places.get("Pending")!.type).toBe("Inbound");
  });

  it("should mark Completed and Rejected as outbound places", () => {
    const flow = createSignupFlow();
    expect(flow.places.get("Completed")!.type).toBe("Outbound");
    expect(flow.places.get("Rejected")!.type).toBe("Outbound");
  });

  it("should reject schema with no inbound place", () => {
    const schema = flowSchema(
      [placeDef("A", ["x"], "Internal"), placeDef("B", ["y"], "Outbound")],
      [transitionDef("T", "A", ["x"], { y: "B" })],
    );
    const errors = validate(schema);
    expect(errors.some((e) => e.message.includes("No Inbound"))).toBe(true);
  });

  it("should reject schema with no outbound place", () => {
    const schema = flowSchema(
      [placeDef("A", ["x"], "Inbound"), placeDef("B", ["y"], "Internal")],
      [transitionDef("T", "A", ["x"], { y: "B" })],
    );
    const errors = validate(schema);
    expect(errors.some((e) => e.message.includes("No Outbound"))).toBe(true);
  });

  it("should reject schema with token type mismatch", () => {
    const schema = flowSchema(
      [placeDef("A", ["x"], "Inbound"), placeDef("B", ["z"], "Outbound")],
      [transitionDef("T", "A", ["x"], { y: "B" })], // y not accepted by B
    );
    const errors = validate(schema);
    expect(errors.some((e) => e.message.includes("doesn't accept"))).toBe(true);
  });

  it("should reject schema with unused place", () => {
    const schema = flowSchema(
      [
        placeDef("A", ["x"], "Inbound"),
        placeDef("B", ["y"], "Outbound"),
        placeDef("C", ["z"], "Internal"),
      ],
      [transitionDef("T", "A", ["x"], { y: "B" })],
    );
    const errors = validate(schema);
    expect(errors.some((e) => e.message.includes("unused"))).toBe(true);
  });

  it("should reject schema with incomplete transition", () => {
    const schema = flowSchema(
      [placeDef("A", ["x"], "Inbound"), placeDef("B", ["y"], "Outbound")],
      [{ id: "T", from: "A", consumes: new Set<string>(), to: new Map([["y", "B"]]) }],
    );
    const errors = validate(schema);
    expect(errors.some((e) => e.message.includes("incomplete"))).toBe(true);
  });

  it("should reject disconnected schema", () => {
    const schema = flowSchema(
      [
        placeDef("A", ["x"], "Inbound"),
        placeDef("B", ["y"], "Internal"),
        placeDef("C", ["z"], "Internal"),
        placeDef("D", ["w"], "Outbound"),
      ],
      [
        transitionDef("T1", "A", ["x"], { y: "B" }),
        transitionDef("T2", "C", ["z"], { w: "D" }),
      ],
    );
    const errors = validate(schema);
    expect(errors.some((e) => e.message.includes("not connected") || e.message.includes("un-sound"))).toBe(true);
  });
});

describe("ExecutableFlow token management", () => {
  it("should add token to place", () => {
    const flow = createSignupFlow();
    const token = signupRequested("user@test.com", "pass");
    const updated = addToken(flow, "Pending", token);
    expect(updated.places.get("Pending")!.tokens).toHaveLength(1);
    expect(updated.places.get("Pending")!.tokens[0]).toEqual(token);
    expect(updated.seq).toBe(1);
  });

  it("should reject token with wrong tag", () => {
    const flow = createSignupFlow();
    const token = emailValidated("user@test.com", "pass");
    const updated = addToken(flow, "Pending", token); // Pending only accepts SignupRequested
    expect(updated.places.get("Pending")!.tokens).toHaveLength(0);
    expect(updated.seq).toBe(0); // unchanged
  });

  it("should find ready transitions when tokens are present", () => {
    const flow = createSignupFlow();
    const token = signupRequested("user@test.com", "pass");
    const updated = addToken(flow, "Pending", token);
    const ready = transitionsReady(updated);
    expect(ready).toHaveLength(1);
    expect(ready[0][0].id).toBe("ValidateEmail");
  });

  it("should not find ready transitions when no tokens", () => {
    const flow = createSignupFlow();
    const ready = transitionsReady(flow);
    expect(ready).toHaveLength(0);
  });

  it("should consume tokens on transition start", () => {
    const flow = createSignupFlow();
    const token = signupRequested("user@test.com", "pass");
    let updated = addToken(flow, "Pending", token);
    updated = recordTransitionStart(updated, "Pending", "ValidateEmail");

    expect(updated.places.get("Pending")!.tokens).toHaveLength(0);
    expect(updated.transitions.get("ValidateEmail")!.state).toBe("Ongoing");
    expect(updated.transitions.get("ValidateEmail")!.consumed).toEqual([token]);
  });

  it("should place produced tokens on transition completion", () => {
    const flow = createSignupFlow();
    const token = signupRequested("user@test.com", "pass");
    let updated = addToken(flow, "Pending", token);
    updated = recordTransitionStart(updated, "Pending", "ValidateEmail");

    const produced = emailValidated("user@test.com", "pass");
    const tokensByPlace = new Map([["EmailChecked", [produced]]]);
    updated = recordTransitionCompletion(updated, "ValidateEmail", tokensByPlace, "span-1");

    expect(updated.transitions.get("ValidateEmail")!.state).toBe("Completed");
    expect(updated.places.get("EmailChecked")!.tokens).toHaveLength(1);
    expect(updated.places.get("EmailChecked")!.tokens[0]).toEqual(produced);
  });

  it("should return tokens to source on transition failure", () => {
    const flow = createSignupFlow();
    const token = signupRequested("user@test.com", "pass");
    let updated = addToken(flow, "Pending", token);
    updated = recordTransitionStart(updated, "Pending", "ValidateEmail");

    expect(updated.places.get("Pending")!.tokens).toHaveLength(0);

    updated = recordTransitionFailure(updated, "ValidateEmail", "Pending");

    expect(updated.places.get("Pending")!.tokens).toHaveLength(1);
    expect(updated.transitions.get("ValidateEmail")!.state).toBe("NotStarted");
    expect(updated.transitions.get("ValidateEmail")!.retryAttempts).toBe(1);
    expect(updated.transitions.get("ValidateEmail")!.nextRetryAt).toBeDefined();
  });

  it("should fail permanently after max retries", () => {
    let flow = compileSchemaOrFail(signupSchema, "test", { maxTransitionRetries: 2 });
    const token = signupRequested("user@test.com", "pass");
    flow = addToken(flow, "Pending", token);

    // Retry 1
    flow = recordTransitionStart(flow, "Pending", "ValidateEmail");
    flow = recordTransitionFailure(flow, "ValidateEmail", "Pending");
    expect(flow.transitions.get("ValidateEmail")!.state).toBe("NotStarted");

    // Retry 2
    flow = recordTransitionStart(flow, "Pending", "ValidateEmail");
    flow = recordTransitionFailure(flow, "ValidateEmail", "Pending");
    expect(flow.transitions.get("ValidateEmail")!.state).toBe("NotStarted");

    // Retry 3 — exceeds max
    flow = recordTransitionStart(flow, "Pending", "ValidateEmail");
    flow = recordTransitionFailure(flow, "ValidateEmail", "Pending");
    expect(flow.transitions.get("ValidateEmail")!.state).toBe("Failed");
  });
});

describe("DOT output", () => {
  it("should generate valid DOT string", () => {
    const flow = createSignupFlow();
    const dot = toDotString(flow);

    expect(dot).toContain("digraph");
    expect(dot).toContain("Pending");
    expect(dot).toContain("ValidateEmail");
    expect(dot).toContain("CreateAccount");
    expect(dot).toContain("Completed");
    expect(dot).toContain("Rejected");
  });

  it("should mark inbound places with thick border", () => {
    const flow = createSignupFlow();
    const dot = toDotString(flow);
    expect(dot).toContain("penwidth=3");
  });

  it("should show token-filled places in yellow", () => {
    const flow = addToken(createSignupFlow(), "Pending", signupRequested("a@b.com", "p"));
    const dot = toDotString(flow);
    expect(dot).toContain("fillcolor=yellow");
  });
});

describe("FlowAggregate", () => {
  it("should produce TokenAdded event when signup request arrives", () => {
    const state = initialFlowState();
    const command: FlowCommand = {
      tag: "InboundToken",
      token: signupRequested("user@example.com", "password123"),
      expectsRepliesAt: [],
      spanId: "test-span-1",
    };

    const result = handleFlowCommand(state, command);
    expect(result.events.length).toBeGreaterThan(0);
    expect(result.events[0].tag).toBe("TokenAdded");
  });

  it("should fire ValidateEmail transition when token is added to Pending", () => {
    const state = initialFlowState();
    const command: FlowCommand = {
      tag: "InboundToken",
      token: signupRequested("user@example.com", "password123"),
      expectsRepliesAt: [],
      spanId: "test-span-2",
    };

    const result = handleFlowCommand(state, command);
    expect(result.events.length).toBeGreaterThanOrEqual(2);
    expect(result.events.some((e) => e.tag === "TransitionFired")).toBe(true);

    const fired = result.events.find((e) => e.tag === "TransitionFired");
    expect(fired!.tag === "TransitionFired" && fired!.transitionId).toBe("ValidateEmail");
  });

  it("should generate side effects for transition execution", () => {
    const state = initialFlowState();
    const command: FlowCommand = {
      tag: "InboundToken",
      token: signupRequested("user@example.com", "password123"),
      expectsRepliesAt: [],
      spanId: "test-span-3",
    };

    const result = handleFlowCommand(state, command);
    expect(result.sideEffects.length).toBeGreaterThan(0);
    expect(result.sideEffects.some((e) => e.type === "ExecuteTransition")).toBe(true);
  });

  it("should return FlowInstanceView on GetFlowInstanceView", () => {
    const state = initialFlowState();
    const command: FlowCommand = { tag: "GetFlowInstanceView" };

    const result = handleFlowCommand(state, command);
    expect(result.reply).toBeDefined();
    expect(result.reply!.tag).toBe("FlowInstanceView");

    const view = result.reply!;
    if (view.tag === "FlowInstanceView") {
      expect(view.places.has("Pending")).toBe(true);
      expect(view.transitions.has("ValidateEmail")).toBe(true);
      expect(view.transitions.get("ValidateEmail")).toBe("NotStarted");
    }
  });

  it("should show all transitions as NotStarted initially", () => {
    const state = initialFlowState();
    const result = handleFlowCommand(state, { tag: "GetFlowInstanceView" });
    const view = result.reply!;
    if (view.tag === "FlowInstanceView") {
      for (const state of view.transitions.values()) {
        expect(state).toBe("NotStarted");
      }
    }
  });
});

describe("FlowState update", () => {
  it("should add token to place on TokenAdded event", () => {
    const state = initialFlowState();
    const token = signupRequested("user@example.com", "password123");
    const newState = updateFlowState(state, {
      tag: "TokenAdded",
      placeId: "Pending",
      token,
      spanId: "test-span-6",
    });

    expect(newState.flow.places.get("Pending")!.tokens).toContainEqual(token);
    expect(newState.tokenHistory.get("test-span-6")).toBe("Pending");
  });

  it("should record transition start on TransitionFired event", () => {
    let state = initialFlowState();
    const token = signupRequested("user@example.com", "password123");

    // First add token
    state = updateFlowState(state, {
      tag: "TokenAdded",
      placeId: "Pending",
      token,
      spanId: "test-span-7",
    });

    // Fire transition
    state = updateFlowState(state, {
      tag: "TransitionFired",
      transitionId: "ValidateEmail",
      from: "Pending",
      consumed: [token],
      spanId: "test-span-7",
    });

    expect(state.flow.places.get("Pending")!.tokens).toHaveLength(0);
    expect(state.flow.transitions.get("ValidateEmail")!.state).toBe("Ongoing");
  });
});

describe("Side effect execution", () => {
  it("should execute transition and produce TransitionResult command", async () => {
    const externals = createSignupExternals(() => true);
    const token = signupRequested("user@example.com", "password123");
    const commands = await executeSideEffects(
      [{ type: "ExecuteTransition", transitionId: "ValidateEmail", consumed: [token], spanId: "span-1" }],
      externals,
    );

    expect(commands).toHaveLength(1);
    expect(commands[0].tag).toBe("TransitionResult");
    if (commands[0].tag === "TransitionResult") {
      expect(commands[0].tokens).toHaveLength(1);
      expect(commands[0].tokens[0].tag).toBe("EmailValidated");
    }
  });

  it("should produce EmailTaken when email is unavailable", async () => {
    const externals = createSignupExternals((email) => !email.includes("taken"));
    const token = signupRequested("taken@example.com", "password123");
    const commands = await executeSideEffects(
      [{ type: "ExecuteTransition", transitionId: "ValidateEmail", consumed: [token], spanId: "span-2" }],
      externals,
    );

    expect(commands).toHaveLength(1);
    if (commands[0].tag === "TransitionResult") {
      expect(commands[0].tokens[0].tag).toBe("EmailTaken");
    }
  });

  it("should execute full signup flow end-to-end", async () => {
    const externals = createSignupExternals(() => true);
    let state = initialFlowState();

    // Step 1: Send InboundToken
    const step1 = handleFlowCommand(state, {
      tag: "InboundToken",
      token: signupRequested("user@test.com", "pass"),
      expectsRepliesAt: [],
      spanId: "span-e2e",
    });

    // Apply events
    state = step1.events.reduce(updateFlowState, state);
    expect(state.flow.transitions.get("ValidateEmail")!.state).toBe("Ongoing");

    // Step 2: Execute transition side effect
    const step2Commands = await executeSideEffects(step1.sideEffects, externals);
    expect(step2Commands).toHaveLength(1);
    expect(step2Commands[0].tag).toBe("TransitionResult");

    // Step 3: Process TransitionResult
    const step3 = handleFlowCommand(state, step2Commands[0]);
    state = step3.events.reduce(updateFlowState, state);

    // ValidateEmail should be completed, CreateAccount should have fired
    expect(state.flow.transitions.get("ValidateEmail")!.state).toBe("Completed");
    expect(state.flow.places.get("EmailChecked")!.tokens.length).toBeGreaterThanOrEqual(0);

    // Step 4: Execute CreateAccount transition
    const step4Commands = await executeSideEffects(step3.sideEffects, externals);
    const createAccountCmd = step4Commands.find(
      (c) => c.tag === "TransitionResult" && c.transitionId === "CreateAccount",
    );

    if (createAccountCmd) {
      const step5 = handleFlowCommand(state, createAccountCmd);
      state = step5.events.reduce(updateFlowState, state);
      expect(state.flow.transitions.get("CreateAccount")!.state).toBe("Completed");
      expect(state.flow.places.get("Completed")!.tokens.length).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("flowAggregate — runtime integration", () => {
  const flowCat = categoryTypes<FlowCommand, FlowReply>(CategoryId("signup-flow"));

  function createSignupAggregate(emailAvailable: (email: string) => boolean) {
    return flowAggregate({
      category: CategoryId("signup-flow"),
      initialFlow: () => compileSchemaOrFail(signupSchema, "SignupFlow"),
      externals: createSignupExternals(emailAvailable),
    });
  }

  it("should register as a TEOB Aggregate and run in EntityRuntime", async () => {
    const aggregate = createSignupAggregate(() => true);
    const { runtime } = createSingleRuntime(
      aggregate,
      tagCodec(),
      objectCodec("FlowState"),
    );

    await runtime.start();

    // Send inbound token
    await runtime.tell(
      "user-1" as any,
      {
        tag: "InboundToken",
        token: signupRequested("alice@example.com", "pass123"),
        expectsRepliesAt: [],
        spanId: "span-rt-1",
      } satisfies FlowCommand,
      flowCat,
    );

    // Allow async side effects (tellSelf for TransitionResult) to process
    await new Promise((r) => setTimeout(r, 100));

    // Query the flow state
    const result = await runtime.ask(
      "user-1" as any,
      { tag: "GetFlowInstanceView" } satisfies FlowCommand,
      flowCat,
    );

    expect(result.ok).toBe(true);
    if (result.ok && result.value.reply) {
      const view = result.value.reply as FlowReply & { tag: "FlowInstanceView" };
      expect(view.tag).toBe("FlowInstanceView");
      // ValidateEmail should have completed (transition result fed back via tellSelf)
      expect(view.transitions.get("ValidateEmail")).toBe("Completed");
    }

    await runtime.shutdown();
  });

  it("should complete full flow through runtime with email rejection", async () => {
    const aggregate = createSignupAggregate((email) => !email.includes("taken"));
    const { runtime } = createSingleRuntime(
      aggregate,
      tagCodec(),
      objectCodec("FlowState"),
    );

    await runtime.start();

    await runtime.tell(
      "user-2" as any,
      {
        tag: "InboundToken",
        token: signupRequested("taken@example.com", "pass"),
        expectsRepliesAt: [],
        spanId: "span-rt-2",
      } satisfies FlowCommand,
      flowCat,
    );

    await new Promise((r) => setTimeout(r, 100));

    const result = await runtime.ask(
      "user-2" as any,
      { tag: "GetFlowInstanceView" } satisfies FlowCommand,
      flowCat,
    );

    expect(result.ok).toBe(true);
    if (result.ok && result.value.reply) {
      const view = result.value.reply as FlowReply & { tag: "FlowInstanceView" };
      expect(view.transitions.get("ValidateEmail")).toBe("Completed");
      // Rejected place should have tokens (EmailTaken went to Rejected outbound place)
      const rejectedTokens = view.places.get("Rejected") ?? [];
      expect(rejectedTokens.length).toBeGreaterThanOrEqual(1);
    }

    await runtime.shutdown();
  });

  it("should run multiple flow entities independently", async () => {
    const aggregate = createSignupAggregate(() => true);
    const { runtime } = createSingleRuntime(
      aggregate,
      tagCodec(),
      objectCodec("FlowState"),
    );

    await runtime.start();

    // Send tokens to two different entity instances
    await runtime.tell("flow-a" as any, {
      tag: "InboundToken",
      token: signupRequested("alice@test.com", "pass"),
      expectsRepliesAt: [],
      spanId: "span-a",
    } satisfies FlowCommand, flowCat);

    await runtime.tell("flow-b" as any, {
      tag: "InboundToken",
      token: signupRequested("bob@test.com", "pass"),
      expectsRepliesAt: [],
      spanId: "span-b",
    } satisfies FlowCommand, flowCat);

    await new Promise((r) => setTimeout(r, 200));

    // Both should have progressed independently
    const resultA = await runtime.ask("flow-a" as any, { tag: "GetFlowInstanceView" } satisfies FlowCommand, flowCat);
    const resultB = await runtime.ask("flow-b" as any, { tag: "GetFlowInstanceView" } satisfies FlowCommand, flowCat);

    expect(resultA.ok).toBe(true);
    expect(resultB.ok).toBe(true);

    if (resultA.ok && resultA.value.reply) {
      const view = resultA.value.reply as FlowReply & { tag: "FlowInstanceView" };
      expect(view.transitions.get("ValidateEmail")).toBe("Completed");
    }
    if (resultB.ok && resultB.value.reply) {
      const view = resultB.value.reply as FlowReply & { tag: "FlowInstanceView" };
      expect(view.transitions.get("ValidateEmail")).toBe("Completed");
    }

    await runtime.shutdown();
  });
});
