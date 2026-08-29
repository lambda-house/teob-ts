/** Lifecycle phases for structured startup/shutdown logging. */
export type LifecyclePhase = "Infra" | "Outside" | "Entities" | "Context";

/** Lifecycle logger for structured startup/shutdown logging. */
export interface LifecycleLogger {
  starting(phase: LifecyclePhase): void;
  started(phase: LifecyclePhase, durationMs: number): void;
  stopping(phase: LifecyclePhase): void;
  stopped(phase: LifecyclePhase): void;
  serviceReady(): void;
  serviceShutdown(): void;
}

/** Create a lifecycle logger that writes to console. */
export function createLifecycleLogger(serviceName = "SERVICE"): LifecycleLogger {
  return {
    starting(phase) {
      console.log(`[${serviceName}] Starting ${phase} layer...`);
    },
    started(phase, durationMs) {
      console.log(`[${serviceName}] ${phase} layer ready (took ${durationMs}ms)`);
    },
    stopping(phase) {
      console.log(`[${serviceName}] Stopping ${phase} layer...`);
    },
    stopped(phase) {
      console.log(`[${serviceName}] ${phase} layer stopped`);
    },
    serviceReady() {
      console.log(`[${serviceName}] Service fully initialized and ready`);
    },
    serviceShutdown() {
      console.log(`[${serviceName}] Service shutdown complete`);
    },
  };
}

/** No-op lifecycle logger for testing. */
export function noopLifecycleLogger(): LifecycleLogger {
  return {
    starting() {},
    started() {},
    stopping() {},
    stopped() {},
    serviceReady() {},
    serviceShutdown() {},
  };
}
