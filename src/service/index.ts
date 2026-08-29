export type { HealthCheckResult, HealthCheckConfig, HealthCheck, AggregatedHealth } from "./health-check.js";
export { HealthStatus, defaultHealthCheckConfig, simpleHealthCheck, aggregateHealth } from "./health-check.js";

export type { LifecyclePhase, LifecycleLogger } from "./lifecycle.js";
export { createLifecycleLogger, noopLifecycleLogger } from "./lifecycle.js";

export type { StartupPhase, ProbeServerConfig, ProbeServerControl } from "./probe-server.js";
export { defaultProbeServerConfig, createProbeServer } from "./probe-server.js";

export type {
  ServiceConfig,
  HttpServerConfig,
  RunningService,
  ComponentExports,
  ServiceTemplate,
} from "./service-template.js";
export { defaultServiceConfig, emptyComponentExports, buildService } from "./service-template.js";

export * as Slack from "./slack/index.js";
export { SlackClient } from "./slack/client.js";
export type {
  SlackClientOpts,
} from "./slack/client.js";
export type {
  SlackPostMessage,
  SlackUpdateMessage,
  SlackPostEphemeral,
  SlackAddReaction,
  SlackApiResponse,
} from "./slack/types.js";
