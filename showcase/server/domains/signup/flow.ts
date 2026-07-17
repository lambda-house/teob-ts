/**
 * Signup flow — Petri Net driven user registration.
 *
 * Re-exports the signup flow example with showcase-specific defaults.
 */

export {
  signupFlowSchema,
  signupRequested,
  SignupFlowCategory,
  signupFlowAggregate,
  signupFlowExternals,
  type SignupFlowDeps,
  type SignupRequested,
  type EmailValidated,
  type AccountCreated,
  type EmailTaken,
} from "../../../../test/example/signup-flow.js";
