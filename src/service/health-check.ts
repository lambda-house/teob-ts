/** Health status of a component. */
export type HealthStatus =
  | { tag: "Healthy" }
  | { tag: "Unhealthy"; reason: string }
  | { tag: "Degraded"; reason: string }
  | { tag: "Unknown"; reason: string };

export const HealthStatus = {
  Healthy: { tag: "Healthy" } as HealthStatus,
  Unhealthy: (reason: string): HealthStatus => ({ tag: "Unhealthy", reason }),
  Degraded: (reason: string): HealthStatus => ({ tag: "Degraded", reason }),
  Unknown: (reason: string): HealthStatus => ({ tag: "Unknown", reason }),

  isHealthy(s: HealthStatus): boolean {
    return s.tag === "Healthy" || s.tag === "Degraded";
  },

  isReady(s: HealthStatus): boolean {
    return s.tag === "Healthy" || s.tag === "Degraded";
  },

  /** Combine multiple statuses — worst wins. Priority: Unhealthy > Unknown > Degraded > Healthy */
  combine(statuses: HealthStatus[]): HealthStatus {
    return statuses.reduce<HealthStatus>((acc, s) => {
      const priority = (h: HealthStatus) =>
        h.tag === "Unhealthy" ? 3 : h.tag === "Unknown" ? 2 : h.tag === "Degraded" ? 1 : 0;
      if (priority(s) > priority(acc)) return s;
      if (priority(s) === priority(acc) && s.tag !== "Healthy" && acc.tag !== "Healthy") {
        const accReason = "reason" in acc ? acc.reason : "";
        const sReason = "reason" in s ? s.reason : "";
        return { ...s, reason: `${accReason}; ${sReason}` } as HealthStatus;
      }
      return acc;
    }, HealthStatus.Healthy);
  },

  label(s: HealthStatus): string {
    return s.tag === "Healthy" ? "healthy"
      : s.tag === "Degraded" ? "degraded"
      : s.tag === "Unhealthy" ? "unhealthy"
      : "unknown";
  },
};

/** Detailed health check result with timing metadata. */
export interface HealthCheckResult {
  name: string;
  status: HealthStatus;
  latencyMs: number;
  checkedAt: Date;
}

/** Configuration for health checks. */
export interface HealthCheckConfig {
  checkIntervalMs: number;
  timeoutMs: number;
  degradedThresholdMs: number;
}

export const defaultHealthCheckConfig: HealthCheckConfig = {
  checkIntervalMs: 30_000,
  timeoutMs: 5_000,
  degradedThresholdMs: 1_000,
};

/** Health check for monitoring a system component. */
export interface HealthCheck {
  name: string;
  check(): Promise<HealthCheckResult>;
}

/** Create a simple health check from a name and a status function. */
export function simpleHealthCheck(
  name: string,
  checkStatus: () => Promise<HealthStatus>,
): HealthCheck {
  return {
    name,
    async check() {
      const start = Date.now();
      const status = await checkStatus();
      return { name, status, latencyMs: Date.now() - start, checkedAt: new Date() };
    },
  };
}

/** Aggregated health check result. */
export interface AggregatedHealth {
  overall: HealthStatus;
  components: Record<string, HealthStatus>;
}

/** Run all health checks and aggregate results. */
export async function aggregateHealth(checks: HealthCheck[]): Promise<AggregatedHealth> {
  const results = await Promise.all(checks.map((c) => c.check()));
  const components: Record<string, HealthStatus> = {};
  for (const r of results) {
    components[r.name] = r.status;
  }
  const overall = HealthStatus.combine(results.map((r) => r.status));
  return { overall, components };
}
