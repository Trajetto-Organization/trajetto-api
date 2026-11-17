import type { FastifyReply, FastifyRequest } from "fastify";

import { env } from "@/env";
import { ServiceBusyError } from "@/shared/errors/service-busy-error";
import { poolLimitOf, type PoolStats } from "@/shared/health/pool-metrics";
import { routeGroupOf, type RouteGroup } from "@/shared/health/route-groups";
import {
  SHED_THRESHOLDS,
  shouldShed,
  type PressureReading,
  type ShedClass,
} from "@/shared/http/shed-classes";

/**
 * Load shedding at runtime (plano-escala F2-24): what @fastify/under-pressure
 * calls when the replica is pressed, the counters it keeps and the signals
 * it reads. Which routes may be refused is shed-classes.ts.
 *
 * The plugin has ONE set of thresholds per registration, so it is registered
 * once with the lowest (`deferrable`'s: event-loop utilisation 0.95, lag
 * 300 ms, the pool's waiting queue longer than the pool) and calls
 * `handlePressure` for every request that arrives while any of them is
 * crossed. The handler decides by the route's class; when it returns
 * nothing, the request goes on as if nothing happened.
 *
 * `SHED_MODE=observe` (the default) never refuses: it counts what enforce
 * would have refused (`would_shed`), per route group, in the `shedding`
 * section of the ops_sample row and of /health/metrics. A wrong class would
 * turn real work away, so the owner reads seven days of those counters
 * before switching to `enforce`. In enforce the refusal is 503
 * SERVICE_BUSY with Retry-After (5 s; 120 s for the GPS positions, the
 * app's own back-off), answered before the session lookup or any query.
 *
 * The positions are counted and never refused here, whatever the mode: an
 * app build without back-off answers a 503 by sending again at once, so the
 * positions wait for the fleet's contract (F2-25).
 */

type ShedMode = "observe" | "enforce";

/** Seconds the client is told to wait after a shed request. */
const SHED_RETRY_AFTER_SECONDS = 5;

/** The positions' wait: the app keeps the points and sends them later. */
const POSITIONS_SHED_RETRY_AFTER_SECONDS = 120;

/** Which threshold the request arrived under. */
type PressureReason = "elu" | "lag" | "pool";

interface ShedWindowSample {
  window_seconds: number;
  mode: ShedMode;
  /** Requests that arrived while a threshold was crossed. */
  under_pressure: number;
  /** What was crossed, per request (one request may count in several). */
  reasons: Partial<Record<PressureReason, number>>;
  /** Requests enforce would have refused but this mode let through. */
  would_shed: Partial<Record<RouteGroup, number>>;
  /** Requests refused with 503 SERVICE_BUSY. */
  shed: Partial<Record<RouteGroup, number>>;
}

interface ShedMetrics {
  recordPressure(reasons: readonly PressureReason[]): void;
  recordWouldShed(group: RouteGroup): void;
  recordShed(group: RouteGroup): void;

  /** The current window, without resetting it. */
  snapshot(): ShedWindowSample;

  /** The current window, then a fresh one (the ops_sample row). */
  rotate(): ShedWindowSample;
}

function createShedMetrics({
  now = Date.now,
  mode = () => env.SHED_MODE as ShedMode,
}: {
  now?: () => number;
  mode?: () => ShedMode;
} = {}): ShedMetrics {
  let startedAt = now();
  let underPressure = 0;
  let reasons = new Map<PressureReason, number>();
  let wouldShed = new Map<RouteGroup, number>();
  let shed = new Map<RouteGroup, number>();

  const add = <K>(counts: Map<K, number>, key: K) =>
    counts.set(key, (counts.get(key) ?? 0) + 1);

  const object = <K extends string>(counts: Map<K, number>) =>
    Object.fromEntries(
      [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)),
    ) as Partial<Record<K, number>>;

  function snapshot(): ShedWindowSample {
    return {
      window_seconds: Math.round((now() - startedAt) / 100) / 10,
      mode: mode(),
      under_pressure: underPressure,
      reasons: object(reasons),
      would_shed: object(wouldShed),
      shed: object(shed),
    };
  }

  return {
    recordPressure(crossed) {
      underPressure += 1;
      for (const reason of crossed) add(reasons, reason);
    },

    recordWouldShed: (group) => add(wouldShed, group),

    recordShed: (group) => add(shed, group),

    snapshot,

    rotate() {
      const sample = snapshot();

      startedAt = now();
      underPressure = 0;
      reasons = new Map();
      wouldShed = new Map();
      shed = new Map();

      return sample;
    },
  };
}

/** The process-wide counters: the handler writes them, the sample reads them. */
const shedMetrics = createShedMetrics();

/**
 * The signals the plugin's `healthCheck` reads, on an object so a test can
 * press the replica without exhausting a real pool.
 */
const pressureSignals = {
  pool: null as (() => PoolStats | null) | null,
  databaseUrl: undefined as string | undefined,

  /** More requests waiting for a connection than the pool holds. */
  poolSaturated(): boolean {
    try {
      const pool = this.pool?.() ?? null;
      const limit = poolLimitOf(pool, this.databaseUrl);

      return pool !== null && limit !== null && pool.waitingCount > limit;
    } catch {
      // A reading that fails says nothing: never refuse on it.
      return false;
    }
  },
};

/** Which thresholds this reading crosses (deferrable's, the lowest). */
function reasonsOf(reading: PressureReading): PressureReason[] {
  const crossed: PressureReason[] = [];

  if (reading.elu > SHED_THRESHOLDS.deferrable.elu) crossed.push("elu");
  if (reading.lagMs > SHED_THRESHOLDS.deferrable.lagMs) crossed.push("lag");
  if (reading.poolSaturated) crossed.push("pool");

  return crossed;
}

/** What the plugin decorates the instance with (its `memoryUsage`). */
interface PluginReading {
  eventLoopDelay: number;
  eventLoopUtilized: number;
}

/**
 * The plugin's `pressureHandler`. Returns nothing to let the request go on;
 * a rejected promise to refuse it (the plugin hands the error to the error
 * handler of http.ts, which answers 503 with Retry-After).
 *
 * The decision reads the whole reading, not only the threshold the plugin
 * reports (it reports the first one it finds crossed): an interactive
 * request is refused by its own, higher limits whatever crossed first.
 */
function handlePressure(
  request: FastifyRequest,
  _reply: FastifyReply,
  {
    metrics = shedMetrics,
    mode = () => env.SHED_MODE as ShedMode,
  }: { metrics?: ShedMetrics; mode?: () => ShedMode } = {},
): Promise<void> | undefined {
  const usage = (
    request.server as unknown as { memoryUsage?: () => PluginReading }
  ).memoryUsage?.();

  const reading: PressureReading = {
    elu: usage?.eventLoopUtilized ?? 0,
    lagMs: usage?.eventLoopDelay ?? 0,
    poolSaturated: pressureSignals.poolSaturated(),
  };

  metrics.recordPressure(reasonsOf(reading));

  const shedClass: ShedClass =
    request.routeOptions?.config?.shedClass ?? "interactive";

  if (!shouldShed(shedClass, reading)) return undefined;

  const group = routeGroupOf(request.method, request.routeOptions?.url);
  const counted: RouteGroup = group ?? "other";

  // The positions wait for the fleet's contract (F2-25): counted only.
  const enforced = mode() === "enforce" && counted !== "positions";

  if (!enforced) {
    metrics.recordWouldShed(counted);
    return undefined;
  }

  metrics.recordShed(counted);

  return Promise.reject(
    new ServiceBusyError(
      "O sistema está ocupado; tente de novo em instantes.",
      "SERVICE_BUSY",
      shedRetryAfterSeconds(counted),
    ),
  );
}

/** How long a refused request of the group is told to wait. */
function shedRetryAfterSeconds(group: RouteGroup): number {
  return group === "positions"
    ? POSITIONS_SHED_RETRY_AFTER_SECONDS
    : SHED_RETRY_AFTER_SECONDS;
}

/**
 * The plugin's options: the lowest thresholds, the pool check every second
 * and the handler above. `interval` utilisation: the plugin's default is
 * the share since the process started, which a busy minute after a quiet
 * day never moves.
 */
function loadSheddingOptions() {
  return {
    maxEventLoopUtilization: SHED_THRESHOLDS.deferrable.elu,
    maxEventLoopDelay: SHED_THRESHOLDS.deferrable.lagMs,
    eventLoopUtilizationMode: "interval" as const,
    healthCheck: async () => !pressureSignals.poolSaturated(),
    healthCheckInterval: 1_000,
    pressureHandler: (request: FastifyRequest, reply: FastifyReply) =>
      handlePressure(request, reply),
  };
}

export {
  POSITIONS_SHED_RETRY_AFTER_SECONDS,
  SHED_RETRY_AFTER_SECONDS,
  createShedMetrics,
  handlePressure,
  loadSheddingOptions,
  pressureSignals,
  shedMetrics,
  shedRetryAfterSeconds,
  type PressureReason,
  type ShedMetrics,
  type ShedMode,
  type ShedWindowSample,
};
