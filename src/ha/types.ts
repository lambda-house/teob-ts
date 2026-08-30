// ha/types.ts — shared Home Assistant wire types. Do not add teob imports here.

export interface HaContext { id: string; parent_id: string | null; user_id: string | null; }

export interface HaEntityState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string; // ISO
  last_updated: string; // ISO
  context?: HaContext;
}

export interface HaStateChangedEvent {
  entityId: string;
  newState: HaEntityState | null;
  oldState: HaEntityState | null;
  /** ms epoch parsed from event.time_fired (fallback Date.now()). */
  timeFired: number;
  context: HaContext | null;
}

export interface HaCallServiceEvent {
  domain: string;
  service: string;
  serviceData: Record<string, unknown>;
  /** Normalized union of service_data.entity_id and target.entity_id, always an array. */
  entityIds: string[];
  timeFired: number; // ms epoch
  context: HaContext | null;
}

export interface HaStatesSnapshot {
  states: HaEntityState[];
  reason: "initial" | "resync";
  at: number; // ms epoch
}

export interface HaCallServiceRequest {
  domain: string;
  service: string;
  serviceData?: Record<string, unknown>;
  target?: { entity_id?: string | string[]; device_id?: string | string[]; area_id?: string | string[] };
  /** Ask HA to return the service response payload. */
  returnResponse?: boolean;
  timeoutMs?: number; // default 10_000
}

export interface HaCallServiceResult {
  context: HaContext;
  response?: unknown; // present when returnResponse was set
}

/** recorder/list_statistic_ids item — post-Oct-2025 shape. */
export interface HaStatisticIdMeta {
  statistic_id: string;
  source: string;
  name: string | null;
  display_unit_of_measurement: string | null;
  statistics_unit_of_measurement?: string | null;
  unit_class: string | null;
  has_sum: boolean;
  /** 0 = none, 1 = arithmetic, 2 = circular. Derived from legacy has_mean when absent. */
  mean_type: 0 | 1 | 2;
}

export interface HaStatisticValue {
  start: number; // ms epoch
  end: number;   // ms epoch
  mean?: number | null;
  min?: number | null;
  max?: number | null;
  sum?: number | null;
  state?: number | null;
  change?: number | null;
  last_reset?: number | null;
}

export type HaStatisticPeriod = "5minute" | "hour" | "day" | "week" | "month";
export type HaStatisticType = "mean" | "min" | "max" | "sum" | "state" | "change";

export interface HaStatisticsRequest {
  statisticIds: string[];
  startTime: string;  // ISO
  endTime?: string;   // ISO
  period: HaStatisticPeriod;
  types: HaStatisticType[];
  units?: Record<string, string>;
}

export class HaCommandError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "HaCommandError"; }
}
export class HaDisconnectedError extends Error {
  constructor(message = "Home Assistant connection lost") { super(message); this.name = "HaDisconnectedError"; }
}
export class HaTimeoutError extends Error {
  constructor(message = "Home Assistant command timed out") { super(message); this.name = "HaTimeoutError"; }
}
