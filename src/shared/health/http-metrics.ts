import type { FastifyReply, FastifyRequest } from "fastify";

import {
  CLIENT_VERSION_HEADER,
  parseClientVersion,
} from "@/shared/http/client-version";
import {
  ROUTE_GROUPS,
  routeGroupOf,
  type RouteGroup,
} from "@/shared/health/route-groups";

/**
 * The HTTP counters of this process (plano-escala F1-09): how many requests
 * ended in each status class, how long they took per route group, and which
 * app contract sends the GPS positions.
 *
 * What the scale decisions read from them: the 5xx share (the availability
 * SLO), the 429s and 503s on their own (the limiter and the database
 * refusing), the p95 of the panel's reads, and the positions' share of the
 * traffic. Recorded in the `onResponse` hook of every route (src/http.ts) in
 * constant time and memory: twelve groups, ten buckets, six classes — never
 * a label built from data, no businessId, no path with its ids.
 *
 * Two windows, on purpose:
 *
 *  - the counters and the histogram cover the minute of the ops_sample row
 *    (the sample rotates them; /health/metrics shows the window so far);
 *  - the positions' contracts slide over the last ten minutes, per replica,
 *    by the minute, whatever the sample does: that is the adoption the
 *    positions' load shedding waits for (F2-25: "≥ 90% of the POSTs of the
 *    last 10 minutes from contract ≥ 8"). At most sixteen values ("unknown"
 *    is the request without the header), then "other". Only a driver's
 *    session and the version gate's 426 count there (see
 *    `countsAsFleetContract`): the header is anyone's to set.
 */

/**
 * Upper bounds of the latency buckets, in ms; one more bucket counts what is
 * above the last. The counts are per bucket, not cumulative, so the rows of
 * a period add up. Fixed by the sample's version (ops_sample v=1).
 */
const HTTP_LATENCY_BUCKETS_MS = [
  25, 50, 100, 250, 500, 1000, 2500, 5000, 10000,
] as const;

/** Distinct contract values kept in the window; the rest is "other". */
const MAX_POSITIONS_CONTRACTS = 16;

const POSITIONS_CONTRACTS_WINDOW_MINUTES = 10;

const MS_PER_MINUTE = 60_000;

interface HttpClassCounts {
  "2xx": number;
  "3xx": number;
  "4xx": number;
  "5xx": number;
  /** Of the 4xx: the limiter's refusals. */
  "429": number;
  /** Of the 5xx: the database or a dependency refusing (Retry-After). */
  "503": number;
}

interface HttpGroupWindow {
  requests: number;
  classes: HttpClassCounts;
  latency_ms: {
    /** One count per bucket of HTTP_LATENCY_BUCKETS_MS, then above it. */
    counts: number[];
    sum: number;
  };
}

interface PositionsContracts {
  window_minutes: number;
  total: number;
  by_contract: Record<string, number>;
}

interface HttpWindowSample {
  window_seconds: number;
  requests: number;
  classes: HttpClassCounts;
  /** Only the groups that had a request in the window. */
  groups: Partial<Record<RouteGroup, HttpGroupWindow>>;
  positions_contracts: PositionsContracts;
}

interface HttpWindowSnapshot extends HttpWindowSample {
  latency_buckets_ms: readonly number[];
  /** Every group, zero-filled, so a screen never handles a missing key. */
  groups: Record<RouteGroup, HttpGroupWindow>;
}

interface HttpMetrics {
  /** One finished response. `health`: a /health route, outside servedTotal. */
  record(
    group: RouteGroup,
    statusCode: number,
    elapsedMs: number,
    health: boolean,
  ): void;

  /** One POST /route/positions; undefined when it named no contract. */
  recordPositionsContract(contract: number | undefined): void;

  /**
   * The positions' contracts of the last ten minutes alone, without
   * copying the groups: what the positions' load shedding reads (F2-25).
   */
  positionsContracts(): PositionsContracts;

  /** The current window, without resetting it. */
  snapshot(): HttpWindowSnapshot;

  /** The current window, busy groups only, then a fresh one. */
  rotate(): HttpWindowSample;

  /** Requests outside /health since the process started (CPU per request). */
  servedTotal(): number;

  /**
   * Every group's counts since the process started, never reset: the
   * counters of `/metrics` (plano-escala F5-29), which Prometheus turns
   * into rates itself. Copies, every group zero-filled.
   */
  lifetime(): Record<RouteGroup, HttpGroupWindow>;
}

const emptyClasses = (): HttpClassCounts => ({
  "2xx": 0,
  "3xx": 0,
  "4xx": 0,
  "5xx": 0,
  "429": 0,
  "503": 0,
});

const emptyGroup = (): HttpGroupWindow => ({
  requests: 0,
  classes: emptyClasses(),
  latency_ms: {
    counts: new Array<number>(HTTP_LATENCY_BUCKETS_MS.length + 1).fill(0),
    sum: 0,
  },
});

function countClass(classes: HttpClassCounts, statusCode: number): void {
  if (statusCode >= 200 && statusCode < 300) classes["2xx"] += 1;
  else if (statusCode >= 300 && statusCode < 400) classes["3xx"] += 1;
  else if (statusCode >= 400 && statusCode < 500) classes["4xx"] += 1;
  else if (statusCode >= 500 && statusCode < 600) classes["5xx"] += 1;

  if (statusCode === 429) classes["429"] += 1;
  if (statusCode === 503) classes["503"] += 1;
}

function bucketOf(ms: number): number {
  for (let index = 0; index < HTTP_LATENCY_BUCKETS_MS.length; index += 1) {
    if (ms <= HTTP_LATENCY_BUCKETS_MS[index]) return index;
  }

  return HTTP_LATENCY_BUCKETS_MS.length;
}

const copyGroup = (group: HttpGroupWindow): HttpGroupWindow => ({
  requests: group.requests,
  classes: { ...group.classes },
  latency_ms: {
    counts: [...group.latency_ms.counts],
    sum: Math.round(group.latency_ms.sum * 10) / 10,
  },
});

function createHttpMetrics({
  now = Date.now,
}: { now?: () => number } = {}): HttpMetrics {
  let windowStartedAt = now();
  let requests = 0;
  let classes = emptyClasses();
  let groups = new Map<RouteGroup, HttpGroupWindow>(
    ROUTE_GROUPS.map((group) => [group, emptyGroup()]),
  );
  let served = 0;
  const lifetime = new Map<RouteGroup, HttpGroupWindow>(
    ROUTE_GROUPS.map((group) => [group, emptyGroup()]),
  );

  // The contracts' sliding window: one slot per minute that had a POST, and
  // the window's totals kept beside them, so a POST costs one slot update.
  const slots: Array<{ minute: number; counts: Map<string, number> }> = [];
  const totals = new Map<string, number>();

  function expireContracts(minute: number): void {
    while (
      slots.length > 0 &&
      slots[0].minute <= minute - POSITIONS_CONTRACTS_WINDOW_MINUTES
    ) {
      const expired = slots.shift()!;

      for (const [key, count] of expired.counts) {
        const left = (totals.get(key) ?? 0) - count;

        if (left > 0) totals.set(key, left);
        else totals.delete(key);
      }
    }
  }

  function contracts(): PositionsContracts {
    expireContracts(Math.floor(now() / MS_PER_MINUTE));

    const byContract: Record<string, number> = {};
    let total = 0;

    for (const key of [...totals.keys()].sort()) {
      const count = totals.get(key)!;

      byContract[key] = count;
      total += count;
    }

    return {
      window_minutes: POSITIONS_CONTRACTS_WINDOW_MINUTES,
      total,
      by_contract: byContract,
    };
  }

  function windowSeconds(): number {
    return Math.round((now() - windowStartedAt) / 100) / 10;
  }

  function snapshot(): HttpWindowSnapshot {
    const all = {} as Record<RouteGroup, HttpGroupWindow>;

    for (const group of ROUTE_GROUPS)
      all[group] = copyGroup(groups.get(group)!);

    return {
      window_seconds: windowSeconds(),
      requests,
      classes: { ...classes },
      latency_buckets_ms: HTTP_LATENCY_BUCKETS_MS,
      groups: all,
      positions_contracts: contracts(),
    };
  }

  return {
    record(group, statusCode, elapsedMs, health) {
      const ms = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0;
      const counters = groups.get(group) ?? groups.get("other")!;

      requests += 1;
      countClass(classes, statusCode);

      counters.requests += 1;
      countClass(counters.classes, statusCode);
      counters.latency_ms.counts[bucketOf(ms)] += 1;
      counters.latency_ms.sum += ms;

      const total = lifetime.get(group) ?? lifetime.get("other")!;

      total.requests += 1;
      countClass(total.classes, statusCode);
      total.latency_ms.counts[bucketOf(ms)] += 1;
      total.latency_ms.sum += ms;

      if (!health) served += 1;
    },

    recordPositionsContract(contract) {
      const minute = Math.floor(now() / MS_PER_MINUTE);

      expireContracts(minute);

      let key = contract === undefined ? "unknown" : String(contract);

      const named = totals.size - (totals.has("other") ? 1 : 0);
      if (!totals.has(key) && named >= MAX_POSITIONS_CONTRACTS) key = "other";

      let slot = slots[slots.length - 1];

      if (!slot || slot.minute !== minute) {
        slot = { minute, counts: new Map() };
        slots.push(slot);
      }

      slot.counts.set(key, (slot.counts.get(key) ?? 0) + 1);
      totals.set(key, (totals.get(key) ?? 0) + 1);
    },

    positionsContracts: contracts,

    snapshot,

    rotate() {
      const busy: Partial<Record<RouteGroup, HttpGroupWindow>> = {};

      for (const group of ROUTE_GROUPS) {
        const counters = groups.get(group)!;

        if (counters.requests > 0) busy[group] = copyGroup(counters);
      }

      const sample: HttpWindowSample = {
        window_seconds: windowSeconds(),
        requests,
        classes: { ...classes },
        groups: busy,
        positions_contracts: contracts(),
      };

      windowStartedAt = now();
      requests = 0;
      classes = emptyClasses();
      groups = new Map(ROUTE_GROUPS.map((group) => [group, emptyGroup()]));

      return sample;
    },

    servedTotal: () => served,

    lifetime() {
      const all = {} as Record<RouteGroup, HttpGroupWindow>;

      for (const group of ROUTE_GROUPS) {
        all[group] = copyGroup(lifetime.get(group)!);
      }

      return all;
    },
  };
}

/** The process-wide counters: the hook writes them, the sample reads them. */
const httpMetrics = createHttpMetrics();

/**
 * Whether this POST /route/positions speaks for a phone of the fleet, so its
 * `contract=` goes into the adoption window.
 *
 * The header is the client's word, and anyone can send any number: counted
 * on every response, an anonymous loop of 401s naming contract=99 read as a
 * fleet that had already moved on, and F2-25 would have started shedding
 * the positions of the old builds still in half the trucks (or junk values
 * would have filled the sixteen slots and pushed the real ones to "other").
 * So two answers count, and nothing else:
 *
 *  - a driver's session that passed `ensureAuthenticated` (`request.user`
 *    with a driverId, the use case's own NOT_A_DRIVER rule), whatever came
 *    after it: a 400 or a 503 is still that phone calling;
 *  - the version gate's 426, which answers before the session on purpose.
 *    Its contract is below MIN_MOBILE_CONTRACT by construction, so a forged
 *    one can only LOWER the adoption — the shedding waits longer, as today —
 *    and only ever names values below the minimum.
 *
 * Left out: the 401s, the limiter's 429 (it keys on the token's signature,
 * before the lookup) and any other refusal before the session, and a
 * session that is not a driver's (403 NOT_A_DRIVER). They still count as
 * traffic in the group's classes, just not as adoption.
 */
function countsAsFleetContract(
  request: FastifyRequest,
  reply: FastifyReply,
): boolean {
  if (reply.statusCode === 426) return true;

  return Boolean(request.user?.driverId);
}

/**
 * The `onResponse` hook's body: the route's group by its registered pattern,
 * the status and Fastify's own elapsed time; on POST /route/positions from
 * the fleet (`countsAsFleetContract`), the contract the app named. Never
 * throws: a metric must not fail a response that already went out.
 */
function recordHttpResponse(
  request: FastifyRequest,
  reply: FastifyReply,
  metrics: HttpMetrics = httpMetrics,
): void {
  try {
    const url = request.routeOptions?.url;
    const group = routeGroupOf(request.method, url) ?? "other";

    metrics.record(
      group,
      reply.statusCode,
      reply.elapsedTime,
      url !== undefined && url.startsWith("/health"),
    );

    if (
      group === "positions" &&
      request.method === "POST" &&
      countsAsFleetContract(request, reply)
    ) {
      metrics.recordPositionsContract(
        parseClientVersion(request.headers[CLIENT_VERSION_HEADER])?.contract,
      );
    }
  } catch {
    // Counting is best effort; the response is already on its way.
  }
}

export {
  HTTP_LATENCY_BUCKETS_MS,
  MAX_POSITIONS_CONTRACTS,
  POSITIONS_CONTRACTS_WINDOW_MINUTES,
  createHttpMetrics,
  httpMetrics,
  recordHttpResponse,
};
export type {
  HttpClassCounts,
  HttpGroupWindow,
  HttpMetrics,
  HttpWindowSample,
  HttpWindowSnapshot,
  PositionsContracts,
};
