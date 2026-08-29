// views.ts — framework-agnostic HTTP read side: projections, journal, signals,
// tiles, recorder passthrough, SSE stream. Handlers consume Web-standard Request
// and return Web-standard Response. No Hono imports here.

import type { ProjectionStore } from "../projection/index.js";
import type { JournalQuery, JournalReader } from "../core/envelope.js";
import { sseResponse, type SseOptions, type StreamBus } from "./sse.js";

/** Structural — satisfied by SignalStore (src/ha/signal-store.ts) without importing src/ha. */
export interface SignalReader {
  query(q: {
    entityId: string;
    sinceMs?: number;
    untilMs?: number;
    limit?: number;
    order?: "asc" | "desc";
  }): Array<{ obsId: string; at: number; normalized: { value: unknown; unit: string | null } }>;
}

/** Structural — satisfied by HaClient. */
export interface RecorderReader {
  statisticsDuringPeriod(req: {
    statisticIds: string[];
    startTime: string;
    endTime?: string;
    period: string;
    types: string[];
  }): Promise<unknown>;
}

export interface ReadApiDeps {
  projectionStore: ProjectionStore;
  journal: JournalReader;
  signals?: SignalReader; // absent ⇒ /signals returns 501
  recorder?: RecorderReader; // absent ⇒ /recorder returns 501
  tiles?: () => unknown; // app-composed snapshot; absent ⇒ /tiles returns 501
  bus?: StreamBus; // absent ⇒ /stream returns 501
  startedAt?: number;
}

/** Returns undefined when the request does not match any route (caller falls through). */
export type ReadApiHandler = (req: Request) => Promise<Response | undefined>;

export interface ReadApiOptions {
  basePath?: string; // default "/api"
  sse?: SseOptions;
}

const THREE_HOURS_MS = 3 * 3600e3;

class BadRequestError extends Error {}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function notImplemented(detail: string): Response {
  return json({ error: "NotImplemented", detail }, 501);
}

/** Parse an optional numeric query param; throws BadRequestError on garbage. */
function numParam(params: URLSearchParams, name: string): number | undefined {
  const raw = params.get(name);
  if (raw === null) return undefined;
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(n)) {
    throw new BadRequestError(`query param "${name}" must be a number, got "${raw}"`);
  }
  return n;
}

function orderParam(params: URLSearchParams, fallback: "asc" | "desc"): "asc" | "desc" {
  const raw = params.get("order");
  if (raw === null) return fallback;
  if (raw !== "asc" && raw !== "desc") {
    throw new BadRequestError(`query param "order" must be "asc" or "desc", got "${raw}"`);
  }
  return raw;
}

export function createReadApi(
  deps: ReadApiDeps,
  opts?: ReadApiOptions,
): { handle: ReadApiHandler } {
  const basePath = opts?.basePath ?? "/api";
  const startedAt = deps.startedAt ?? Date.now();

  function handleJournal(params: URLSearchParams): Response {
    const category = params.get("category") ?? undefined;
    const entity = params.get("entity") ?? undefined;
    if (entity !== undefined && category === undefined) {
      throw new BadRequestError('query param "entity" requires "category"');
    }
    // Clamp BOTH ends — a negative limit would reach SQLite as LIMIT -1 = "no limit".
    const limit = Math.max(1, Math.min(numParam(params, "limit") ?? 100, 1000));
    const cursor = numParam(params, "cursor");
    const sinceMs = numParam(params, "since");
    const causationId = params.get("causationOf");
    const correlationId = params.get("correlationId");
    const query: JournalQuery = {
      ...(category !== undefined && { category }),
      ...(entity !== undefined && { entityId: entity }),
      ...(cursor !== undefined && { cursor }),
      ...(sinceMs !== undefined && { sinceMs }),
      ...(causationId !== null && { causationId }),
      ...(correlationId !== null && { correlationId }),
      limit,
      order: orderParam(params, "desc"),
    };
    const rows = deps.journal.queryEvents(query);
    const nextCursor = rows.length === limit ? rows[rows.length - 1]!.globalSeq : null;
    return json({ rows, nextCursor });
  }

  function handleChain(eventId: string): Response {
    if (deps.journal.eventByEventId(eventId) === undefined) {
      return json({ error: "EventNotFound", eventId }, 404);
    }
    return json({ chain: deps.journal.causationChain(eventId) });
  }

  function handleSignals(entityId: string, params: URLSearchParams): Response {
    if (!deps.signals) return notImplemented("no signal store configured");
    const sinceMs = numParam(params, "since") ?? Date.now() - THREE_HOURS_MS;
    const untilMs = numParam(params, "until");
    // Clamp BOTH ends — a negative limit would reach SQLite as LIMIT -1 = "no limit".
    const limit = Math.max(1, Math.min(numParam(params, "limit") ?? 500, 5000));
    const order = orderParam(params, "asc");
    // Always query newest-first so a window larger than the limit keeps the
    // NEWEST rows (an asc query would silently truncate the most recent data);
    // reverse afterwards to restore chronological (sparkline) order for "asc".
    const rows = deps.signals.query({
      entityId,
      sinceMs,
      ...(untilMs !== undefined && { untilMs }),
      limit,
      order: "desc",
    });
    if (order === "asc") rows.reverse();
    return json({
      entityId,
      rows: rows.map((r) => ({ at: r.at, value: r.normalized.value, unit: r.normalized.unit })),
    });
  }

  async function handleRecorder(params: URLSearchParams): Promise<Response> {
    if (!deps.recorder) return notImplemented("no recorder reader configured");
    const ids = (params.get("ids") ?? "").split(",").map((s) => s.trim()).filter((s) => s !== "");
    if (ids.length === 0) throw new BadRequestError('query param "ids" is required (comma-separated)');
    const start = params.get("start");
    if (start === null) throw new BadRequestError('query param "start" is required (ISO timestamp)');
    const period = params.get("period");
    if (period === null) throw new BadRequestError('query param "period" is required');
    const types = (params.get("types") ?? "").split(",").map((s) => s.trim()).filter((s) => s !== "");
    if (types.length === 0) throw new BadRequestError('query param "types" is required (comma-separated)');
    const end = params.get("end");
    const result = await deps.recorder.statisticsDuringPeriod({
      statisticIds: ids,
      startTime: start,
      ...(end !== null && { endTime: end }),
      period,
      types,
    });
    return json(result);
  }

  async function route(req: Request): Promise<Response | undefined> {
    const url = new URL(req.url);
    const pathname = url.pathname;
    if (pathname !== basePath && !pathname.startsWith(`${basePath}/`)) {
      return undefined; // not ours — caller falls through to other routes/static files
    }
    if (req.method !== "GET") {
      return json({ error: "MethodNotAllowed" }, 405);
    }

    const segments = pathname
      .slice(basePath.length)
      .split("/")
      .filter((s) => s !== "")
      .map(decodeURIComponent);
    const params = url.searchParams;

    if (segments[0] === "views" && segments.length === 2) {
      const projectionId = segments[1]!;
      return json({ projectionId, views: deps.projectionStore.list(projectionId) });
    }
    if (segments[0] === "views" && segments.length === 3) {
      const envelope = deps.projectionStore.get(segments[1]!, segments[2]!);
      if (envelope === undefined) return json({ error: "ViewNotFound" }, 404);
      return json(envelope);
    }
    if (segments[0] === "journal" && segments.length === 1) {
      return handleJournal(params);
    }
    if (segments[0] === "journal" && segments[1] === "chain" && segments.length === 3) {
      return handleChain(segments[2]!);
    }
    if (segments[0] === "signals" && segments.length === 2) {
      return handleSignals(segments[1]!, params);
    }
    if (segments[0] === "tiles" && segments.length === 1) {
      if (!deps.tiles) return notImplemented("no tiles source configured");
      return json(deps.tiles());
    }
    if (segments[0] === "stream" && segments.length === 1) {
      if (!deps.bus) return notImplemented("no stream bus configured");
      return sseResponse(deps.bus, { startedAt, ...opts?.sse });
    }
    if (segments[0] === "recorder" && segments[1] === "statistics" && segments.length === 2) {
      return handleRecorder(params);
    }

    return json({ error: "NotFound" }, 404);
  }

  return {
    handle: async (req: Request): Promise<Response | undefined> => {
      try {
        return await route(req);
      } catch (err) {
        if (err instanceof BadRequestError) {
          return json({ error: "BadRequest", detail: err.message }, 400);
        }
        throw err;
      }
    },
  };
}
