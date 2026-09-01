import type { CallId, CallError, CallResult } from "./types.js";
import { isTransient } from "./types.js";
import type { RetryPolicy } from "./retry.js";
import { RetryPolicy as RP } from "./retry.js";

export interface DurableCall<Req, Resp> {
  readonly name: string;
  execute(request: Req, callId: CallId): Promise<CallResult<Resp>>;
  retryPolicy: RetryPolicy;
  isRetryable(e: CallError): boolean;
}

export interface DurableCallOpts<Req, Resp> {
  name: string;
  execute: (req: Req, callId: CallId) => Promise<CallResult<Resp>>;
  retryPolicy?: RetryPolicy;
  isRetryable?: (e: CallError) => boolean;
}

export const DurableCall = {
  of<Req, Resp>(opts: DurableCallOpts<Req, Resp>): DurableCall<Req, Resp> {
    return {
      name: opts.name,
      execute: opts.execute,
      retryPolicy: opts.retryPolicy ?? RP.default(),
      isRetryable: opts.isRetryable ?? isTransient,
    };
  },
};
