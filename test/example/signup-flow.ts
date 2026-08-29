/**
 * Example Petri-net flow modeling a user signup process.
 *
 * Mirrors the Scala SignupFlow + SignupFlowAggregate examples.
 *
 * The flow:
 *   1. User submits signup request (email, password) -> SignupRequested token arrives at Pending place
 *   2. ValidateEmail transition fires: checks email availability
 *      - If available: produces EmailValidated token -> EmailChecked place
 *      - If taken: produces EmailTaken token -> Rejected place (outbound)
 *   3. CreateAccount transition fires: creates the account
 *      - Produces AccountCreated token -> Completed place (outbound)
 */

import type { Token } from "../../src/petrinet/types.js";
import type { FlowExternals } from "../../src/petrinet/flow-aggregate.js";
import { flowAggregate } from "../../src/petrinet/flow-aggregate.js";
import { placeDef, transitionDef } from "../../src/petrinet/types.js";
import { flowSchema, compileSchemaOrFail } from "../../src/petrinet/flow-schema.js";
import { CategoryId } from "../../src/core/types.js";

// --- Tokens ---

export interface SignupRequested extends Token {
  tag: "SignupRequested";
  email: string;
  password: string;
}
export interface EmailValidated extends Token {
  tag: "EmailValidated";
  email: string;
  password: string;
}
export interface AccountCreated extends Token {
  tag: "AccountCreated";
  userId: string;
  email: string;
}
export interface EmailTaken extends Token {
  tag: "EmailTaken";
  email: string;
}

export type SignupToken = SignupRequested | EmailValidated | AccountCreated | EmailTaken;

export const signupRequested = (email: string, password: string): SignupRequested => ({
  tag: "SignupRequested",
  email,
  password,
});
export const emailValidated = (email: string, password: string): EmailValidated => ({
  tag: "EmailValidated",
  email,
  password,
});
export const accountCreated = (userId: string, email: string): AccountCreated => ({
  tag: "AccountCreated",
  userId,
  email,
});
export const emailTaken = (email: string): EmailTaken => ({ tag: "EmailTaken", email });

// --- Places ---

export const Pending = placeDef("Pending", ["SignupRequested"], "Inbound");
export const EmailChecked = placeDef("EmailChecked", ["EmailValidated"], "Internal");
export const Completed = placeDef("Completed", ["AccountCreated"], "Outbound");
export const Rejected = placeDef("Rejected", ["EmailTaken"], "Outbound");

// --- Transitions ---

export const ValidateEmail = transitionDef("ValidateEmail", "Pending", ["SignupRequested"], {
  EmailValidated: "EmailChecked",
  EmailTaken: "Rejected",
});

export const CreateAccount = transitionDef("CreateAccount", "EmailChecked", ["EmailValidated"], {
  AccountCreated: "Completed",
});

// --- Flow Schema ---

export const signupFlowSchema = flowSchema(
  [Pending, EmailChecked, Completed, Rejected],
  [ValidateEmail, CreateAccount],
);

// --- Category ---

export const SignupFlowCategory = CategoryId("signup-flow");

// --- Externals factory ---

export interface SignupFlowDeps {
  isEmailAvailable: (email: string) => Promise<boolean>;
  createAccount: (email: string, password: string) => Promise<string>;
  onAccountCreated?: (token: AccountCreated) => Promise<void>;
  onEmailRejected?: (token: EmailTaken) => Promise<void>;
}

export function signupFlowExternals(deps: SignupFlowDeps): FlowExternals {
  return {
    transitions: new Map([
      [
        "ValidateEmail",
        async (_tid, consumed) => {
          const req = consumed.find((t) => t.tag === "SignupRequested") as SignupRequested | undefined;
          if (!req) return { error: "No SignupRequested token" };
          const available = await deps.isEmailAvailable(req.email);
          if (available) {
            return [emailValidated(req.email, req.password)];
          }
          return [emailTaken(req.email)];
        },
      ],
      [
        "CreateAccount",
        async (_tid, consumed) => {
          const validated = consumed.find((t) => t.tag === "EmailValidated") as EmailValidated | undefined;
          if (!validated) return { error: "No EmailValidated token" };
          const userId = await deps.createAccount(validated.email, validated.password);
          return [accountCreated(userId, validated.email)];
        },
      ],
    ]),
    outbound: new Map([
      [
        "Completed",
        async (_placeId, token) => {
          await deps.onAccountCreated?.(token as AccountCreated);
        },
      ],
      [
        "Rejected",
        async (_placeId, token) => {
          await deps.onEmailRejected?.(token as EmailTaken);
        },
      ],
    ]),
  };
}

// --- Aggregate factory ---

/** Create a signup flow aggregate with the given dependencies. */
export function signupFlowAggregate(deps: SignupFlowDeps) {
  return flowAggregate({
    category: SignupFlowCategory,
    initialFlow: () => compileSchemaOrFail(signupFlowSchema, "SignupFlow"),
    externals: signupFlowExternals(deps),
  });
}

/** Convenience: create with simple email check predicate (for tests). */
export function withEmailCheck(
  emailAvailable: (email: string) => boolean,
  accountCreator: (email: string, _password: string) => string = (email) =>
    `user-${Math.abs(email.split("").reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 0))}`,
) {
  return signupFlowAggregate({
    isEmailAvailable: async (email) => emailAvailable(email),
    createAccount: async (email, password) => accountCreator(email, password),
  });
}
