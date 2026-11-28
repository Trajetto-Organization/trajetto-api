import { sleep } from "k6";
import exec from "k6/execution";
import { Counter } from "k6/metrics";

import { SUMMARY_TREND_STATS, context, surfaces } from "./lib/api.js";

/**
 * The writes of the product, together (plano-escala LOAD-03, X-23).
 *
 * Every other scene reads, plus the positions. What a busy hour also writes
 * is here, weighted by how often the product does it: the positions; the
 * bell's NDJSON list (`/notification/stream`) every open tab reads at its
 * tick; the presigned PUT of a proof photo; a message from the office to a
 * driver; a delivery typed on the board. And the session refresh, in a
 * scenario of its own: the refresh token rotates, a session belongs to one
 * VU (`exec.vu.idInTest` picks it), and two VUs sharing one would trip the
 * reuse detection, which ends the session.
 *
 *   WRITE_RATE            writes a second (40)
 *   WRITE_DURATION        how long (3m)
 *   WRITE_PRE_VUS, WRITE_MAX_VUS   the arrival rate's VU budget (40, 120)
 *   WRITE_REFRESH_VUS     sessions refreshing (20), each every
 *   WRITE_REFRESH_EVERY_S seconds (30): the seed must have
 *                         LOAD_REFRESH_SESSIONS ≥ WRITE_MAX_VUS +
 *                         WRITE_REFRESH_VUS, or the VUs past it skip
 */
const RATE = Number(__ENV.WRITE_RATE || 40);
const DURATION = __ENV.WRITE_DURATION || "3m";

const REFRESH_VUS = Math.max(0, Number(__ENV.WRITE_REFRESH_VUS ?? 20));
const REFRESH_EVERY_S = Number(__ENV.WRITE_REFRESH_EVERY_S || 30);

const MIX = [
  { weight: 35, run: (vu) => surfaces.recordPositions(vu) },
  { weight: 25, run: () => surfaces.notificationStream() },
  { weight: 15, run: (vu) => surfaces.presignUpload(vu) },
  { weight: 13, run: (vu) => surfaces.sendChat(vu) },
  { weight: 12, run: () => surfaces.createDelivery() },
];

const TOTAL = MIX.reduce((sum, entry) => sum + entry.weight, 0);

/** Sessions a refresh VU found no session of its own for. */
const skipped = new Counter("refresh_sessions_missing");

const scenarios = {
  writes: {
    executor: "constant-arrival-rate",
    exec: "writes",
    rate: RATE,
    timeUnit: "1s",
    duration: DURATION,
    preAllocatedVUs: Number(__ENV.WRITE_PRE_VUS || 40),
    maxVUs: Number(__ENV.WRITE_MAX_VUS || 120),
  },
};

if (REFRESH_VUS > 0) {
  scenarios.refresh = {
    executor: "constant-vus",
    exec: "refresh",
    vus: REFRESH_VUS,
    duration: DURATION,
    gracefulStop: "10s",
  };
}

export const options = {
  summaryTrendStats: SUMMARY_TREND_STATS,
  scenarios,

  thresholds: {
    "surface_latency{surface:route.positions}": ["p(95)<800"],
    "surface_latency{surface:notification.stream}": ["p(95)<1000"],
    "surface_latency{surface:upload.presign}": ["p(95)<500"],
    "surface_latency{surface:chat.send}": ["p(95)<1000"],
    "surface_latency{surface:delivery.create}": ["p(95)<1000"],
    "surface_latency{surface:user.refresh}": ["p(95)<1000"],

    "surface_failures{surface:route.positions}": ["rate<0.01"],
    "surface_failures{surface:notification.stream}": ["rate<0.01"],
    "surface_failures{surface:upload.presign}": ["rate<0.01"],
    "surface_failures{surface:chat.send}": ["rate<0.01"],
    "surface_failures{surface:delivery.create}": ["rate<0.01"],
    "surface_failures{surface:user.refresh}": ["rate<0.01"],

    surface_throttled: ["rate<0.10"],
    refresh_sessions_missing: ["count==0"],
  },
};

export function setup() {
  if (!context.shipperId) {
    throw new Error(
      "write-mix.js: o fixture não tem shipperId. Semeie de novo (seed.ts escreve o embarcador do tenant principal).",
    );
  }
}

export function writes() {
  let ticket = Math.random() * TOTAL;

  for (const entry of MIX) {
    ticket -= entry.weight;

    if (ticket <= 0) {
      entry.run(__VU);
      return;
    }
  }

  MIX[0].run(__VU);
}

// Per VU: the session it owns, rotated by each refresh.
let session;

export function refresh() {
  if (session === undefined) {
    const sessions = context.refreshSessions || [];

    session = sessions[exec.vu.idInTest - 1] ?? null;

    if (session === null) skipped.add(1);

    // The sessions do not all refresh in the same second.
    sleep(Math.random() * REFRESH_EVERY_S);
  }

  if (session === null) {
    sleep(REFRESH_EVERY_S);
    return;
  }

  session = surfaces.refreshSession(session);

  sleep(REFRESH_EVERY_S * (0.8 + Math.random() * 0.4));
}
