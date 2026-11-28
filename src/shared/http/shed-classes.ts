import { routeGroupOf, type RouteGroup } from "@/shared/health/route-groups";

/**
 * Which requests a pressed replica may turn away, and when (plano-escala
 * F2-24).
 *
 * A replica whose event loop is saturated, or whose database pool has more
 * requests waiting than connections, answers everything late: the GPS flush
 * of a thousand phones, the tower's refresh every few seconds and the driver
 * confirming a delivery all queue behind each other until they time out
 * together. Load shedding answers some of them at once, with 503 and
 * Retry-After, so the others still get through. Which ones is decided per
 * route, by class:
 *
 *  - `critical` always passes: the driver's submissions (arrival, proof,
 *    occurrence, fueling, checklist, the route's start, the photo uploads
 *    they need), the session's refresh, logout and revocation, the public
 *    catalogue (a constant document) and `/health/*` (the orchestrator
 *    restarting a replica that only looked busy would make everything
 *    worse);
 *  - `deferrable` is refused at the first threshold: the GPS positions (the
 *    app keeps the points and sends them later), the tower and dashboard
 *    reads (the web reads again on the next beat) and the exports (a file
 *    that can wait a minute);
 *  - `interactive`, the rest, only when the replica is drowning: above
 *    0.98 of event-loop utilisation or a full second of lag.
 *
 * The class is set on each route's `config.shedClass` when the route is
 * registered (src/http.ts, onRoute), from the route's group
 * (shared/health/route-groups.ts) and the exceptions below; a route may also
 * declare it itself. tests/unitaires/http/shed-classes.test.ts reads every
 * route Fastify registers and pins the critical and deferrable lists, so a
 * new route can only be refused by a decision someone wrote down.
 */

const SHED_CLASSES = ["critical", "interactive", "deferrable"] as const;

type ShedClass = (typeof SHED_CLASSES)[number];

/** The class of every route of a group, unless listed below. */
const SHED_CLASS_BY_GROUP: Readonly<Record<RouteGroup, ShedClass>> = {
  positions: "deferrable",
  tower: "deferrable",
  lists: "interactive",
  details: "interactive",
  driver_writes: "critical",
  panel_writes: "interactive",
  auth: "interactive",
  integration: "interactive",
  notifications: "interactive",
  files: "interactive",
  chat: "interactive",
  other: "interactive",
};

/** `METHOD /pattern` → class, where the route's group does not decide it. */
const SHED_CLASS_EXCEPTIONS: Readonly<Record<string, ShedClass>> = {
  // The exports: a file the person can download a minute later, and the
  // heaviest reads of the panel.
  "GET /fuel/export-fuel": "deferrable",
  "GET /driver/export-driver": "deferrable",
  "GET /vehicle/export-vehicle": "deferrable",
  "GET /vehicle-checklist/export-vehicle-checklist": "deferrable",
  "GET /service-order/export-service-order": "deferrable",
  "GET /account-payable/export-account-payable": "deferrable",
  "GET /fines/export-fine": "deferrable",
  "GET /delivery/export-delivery": "deferrable",
  "GET /delivery/export-occurrence": "deferrable",

  // The photos of the driver's submissions go up by presigned PUT before
  // the submission itself: refusing them stalls the proof just the same.
  "POST /uploads/presign/:businessId": "critical",
  "PUT /uploads/local": "critical",

  // The session: a refresh refused at the wrong second logs a driver out
  // mid-route; ending a session (logout, revocation) is a security action.
  "POST /user/refresh-token": "critical",
  "POST /user/logout": "critical",
  "POST /user/session/revoke": "critical",

  // A constant document, cached for five minutes by whoever reads it:
  // refusing it costs what answering does.
  "GET /integration/v1/catalogue": "critical",

  // The probes and the operator's view of a pressed replica.
  "GET /health": "critical",
  "GET /health/liveness": "critical",
  "GET /health/readiness": "critical",
  "GET /health/rollout": "critical",
  "GET /health/metrics": "critical",
  "GET /health/providers": "critical",
  "GET /health/dead-letter": "critical",
  "GET /health/dead-letter/events": "critical",
  "POST /health/dead-letter/replay": "critical",
  "POST /health/dead-letter/events/replay": "critical",
};

/**
 * The class of a route by its method and registered pattern. A route that
 * no group lists (a 404, a CORS preflight) is `interactive`.
 */
function shedClassOf(method: string, url: string | undefined): ShedClass {
  const verb = method === "HEAD" ? "GET" : method;
  const pattern =
    url !== undefined && url.length > 1 && url.endsWith("/")
      ? url.slice(0, -1)
      : url;

  if (pattern !== undefined) {
    const exception = SHED_CLASS_EXCEPTIONS[`${verb} ${pattern}`];
    if (exception) return exception;
  }

  const group = routeGroupOf(verb, pattern);

  return group ? SHED_CLASS_BY_GROUP[group] : "interactive";
}

/**
 * The thresholds of each class. `deferrable`'s are the ones the plugin is
 * registered with (the lowest): below them the handler is never called.
 */
const SHED_THRESHOLDS = {
  deferrable: { elu: 0.95, lagMs: 300 },
  interactive: { elu: 0.98, lagMs: 1_000 },
} as const;

/** What the plugin measured when the request arrived. */
interface PressureReading {
  /** Event-loop utilisation over the last sample (0..1). */
  elu: number;
  /** Mean event-loop delay over the last sample, in ms. */
  lagMs: number;
  /** More requests waiting for a database connection than the pool holds. */
  poolSaturated: boolean;
}

/**
 * Whether a request of this class would be turned away under this reading.
 * The pool alone refuses only what can wait: an interactive request that
 * finds the pool full waits `pool_timeout` and gets its own 503, as before.
 */
function shouldShed(shedClass: ShedClass, reading: PressureReading): boolean {
  if (shedClass === "critical") return false;

  const limits = SHED_THRESHOLDS[shedClass];
  const loopPressed = reading.elu > limits.elu || reading.lagMs > limits.lagMs;

  return shedClass === "deferrable"
    ? loopPressed || reading.poolSaturated
    : loopPressed;
}

/**
 * The positions' gate (plano-escala F2-25): when the GPS flush may be
 * refused at all.
 *
 * An app build without back-off answers a 503 by sending the same batch
 * again at once, so refusing the positions of a fleet still on old builds
 * multiplies the traffic it meant to shed. Contract 8 of the app (F2-27)
 * waits Retry-After, with jitter, and keeps the points on the phone. So,
 * with `SHED_POSITIONS_MODE=auto` (the default), the positions are refused
 * only while at least 90% of the POSTs of the last ten minutes on THIS
 * replica came from contract 8 or above — the adoption window of
 * shared/health/http-metrics.ts, where only a driver's session and the
 * version gate's 426 count (a forged header cannot open the gate).
 *
 * `observe` keeps them counted only, whatever the adoption; `enforce` opens
 * the gate whatever it. Both under `SHED_MODE`: in observe nothing is ever
 * refused.
 */
const POSITIONS_SHED_MODES = ["auto", "observe", "enforce"] as const;

type PositionsShedMode = (typeof POSITIONS_SHED_MODES)[number];

/** The app contract that backs off (F2-27). */
const POSITIONS_SHED_MIN_CONTRACT = 8;

/** The share of the window that must come from it. */
const POSITIONS_SHED_MIN_ADOPTION = 0.9;

interface PositionsAdoption {
  /** POSTs in the window. */
  total: number;
  /** Of those, from contract POSITIONS_SHED_MIN_CONTRACT or above. */
  adopted: number;
  /** adopted / total; null with no POST in the window. */
  share: number | null;
}

/**
 * The adoption of the window's contracts. `unknown` (no header: the oldest
 * builds) and `other` (past the sixteen values kept, so unknown too) count
 * as old: a guess must keep the gate shut, never open it.
 */
function positionsAdoption(
  byContract: Readonly<Record<string, number>>,
): PositionsAdoption {
  let total = 0;
  let adopted = 0;

  for (const [key, count] of Object.entries(byContract)) {
    if (!Number.isFinite(count) || count <= 0) continue;

    total += count;

    if (/^\d+$/.test(key) && Number(key) >= POSITIONS_SHED_MIN_CONTRACT) {
      adopted += count;
    }
  }

  return { total, adopted, share: total > 0 ? adopted / total : null };
}

/**
 * Whether the positions may be refused under pressure. A window with no
 * POST says nothing about the fleet (a replica that just started): shut.
 */
function positionsMayBeShed(
  mode: PositionsShedMode,
  adoption: PositionsAdoption,
): boolean {
  if (mode === "enforce") return true;
  if (mode === "observe") return false;

  return (
    adoption.share !== null && adoption.share >= POSITIONS_SHED_MIN_ADOPTION
  );
}

export {
  POSITIONS_SHED_MIN_ADOPTION,
  POSITIONS_SHED_MIN_CONTRACT,
  POSITIONS_SHED_MODES,
  positionsAdoption,
  positionsMayBeShed,
  type PositionsAdoption,
  type PositionsShedMode,
  SHED_CLASSES,
  SHED_CLASS_BY_GROUP,
  SHED_CLASS_EXCEPTIONS,
  SHED_THRESHOLDS,
  shedClassOf,
  shouldShed,
  type PressureReading,
  type ShedClass,
};
