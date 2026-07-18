import type { CallGateway } from "../core/call/gateway.js";
import type { CallId, CallResult } from "../core/call/types.js";
import { errorTypeLabel } from "../core/call/types.js";
import type { DurableCall } from "../core/call/durable-call.js";
import { loadTelemetryProvider, type TelemetryProvider } from "./index.js";

export interface InstrumentedCallGatewayOpts {
  provider?: TelemetryProvider;
  serviceName?: string;
}

/**
 * Wrap a CallGateway with OpenTelemetry instrumentation. Adds:
 *   - counter: teob.call.total (gateway, call_name, outcome)
 *   - counter: teob.call.errors (gateway, call_name, error_type)
 *   - histogram: teob.call.duration_ms (gateway, call_name, outcome)
 *   - span: teob.call.<call_name> per execution
 *
 * If @opentelemetry/api is not installed the wrapper is a transparent
 * pass-through with zero overhead.
 */
export function instrumentCallGateway(
  inner: CallGateway,
  opts?: InstrumentedCallGatewayOpts,
): CallGateway {
  const provider = opts?.provider ?? loadTelemetryProvider(opts?.serviceName);
  const { tracer, meter } = provider;

  const totalCounter = meter.createCounter("teob.call.total", {
    description: "Total durable call attempts",
  });
  const errorCounter = meter.createCounter("teob.call.errors", {
    description: "Total durable call errors by error_type",
  });
  const durationHist = meter.createHistogram("teob.call.duration_ms", {
    description: "Durable call duration in ms",
    unit: "ms",
  });

  return {
    name: inner.name,
    breaker: inner.breaker,
    async execute<Req, Resp>(
      call: DurableCall<Req, Resp>,
      request: Req,
      callId: CallId,
    ): Promise<CallResult<Resp>> {
      const span = tracer.startSpan(`teob.call.${call.name}`, {
        attributes: {
          gateway: inner.name,
          call_id: String(callId),
        },
      });
      const start = Date.now();
      try {
        const result = await inner.execute(call, request, callId);
        const elapsed = Date.now() - start;
        const outcome = result.ok ? "success" : "error";
        const labels = { gateway: inner.name, call_name: call.name, outcome };
        totalCounter.add(1, labels);
        durationHist.record(elapsed, labels);
        if (!result.ok) {
          errorCounter.add(1, {
            gateway: inner.name,
            call_name: call.name,
            error_type: errorTypeLabel(result.error),
          });
          span.setStatus({ code: 2, message: errorTypeLabel(result.error) });
        } else {
          span.setStatus({ code: 1 });
        }
        return result;
      } catch (err) {
        const elapsed = Date.now() - start;
        totalCounter.add(1, { gateway: inner.name, call_name: call.name, outcome: "error" });
        durationHist.record(elapsed, { gateway: inner.name, call_name: call.name, outcome: "error" });
        errorCounter.add(1, {
          gateway: inner.name,
          call_name: call.name,
          error_type: "thrown",
        });
        span.setStatus({ code: 2, message: String(err) });
        throw err;
      } finally {
        span.end();
      }
    },
  };
}
