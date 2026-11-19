import exec from "k6/execution";
import { Counter } from "k6/metrics";

import { SUMMARY_TREND_STATS, context, surfaces } from "./lib/api.js";

/**
 * The fleet's GPS at the 5M gate's rate (plano-escala LOAD-11, section 6,
 * "Portão do 5M"): 500 POST/s of 4 points each, 2,000 points a second,
 * for ten minutes, and the 10× headroom (3,330 POST/s) with the same file.
 *
 * positions.js is the fleet as the phones pace it (the server's hint
 * decides the rate); this one holds the rate the gate names, whatever the
 * answers say, so a run measures the write path at that rate and nothing
 * else: a constant arrival rate, each iteration a flush of the next
 * driver's minute (the fixture's drivers in turn: twenty thousand at the
 * 5m tier, each one every 40 s at 500/s). It is the scene of the ABBA of
 * the group commit and of the session cache (positions-abba.sh, A with
 * both off, B with both on): POSITIONS_5M_ARM tags every sample with its
 * arm.
 *
 * Every point the API answered 200 for must be in the database: the
 * answer's `data.stored` (what was inserted; a resend is answered with 0)
 * adds up in `positions_points_stored`, and positions-abba.sh counts the
 * rows of the run's window in driver_position_v2 against it ("0 ponto
 * perdido"). The window is printed by the teardown as one line:
 * `POSITIONS_5M_WINDOW {"from":…,"to":…}`.
 *
 *   POSITIONS_5M_RATE        POST/s (500; 3330 for the 10× headroom)
 *   POSITIONS_5M_POINTS      points per POST (4)
 *   POSITIONS_5M_DURATION    how long (10m)
 *   POSITIONS_5M_MAX_VUS     VUs the rate may take (2000)
 *   POSITIONS_5M_ARM         the ABBA arm (A or B), a tag on every sample
 *   POSITIONS_5M_ACCEPTANCE  true: the gate's thresholds (p95 < 150 ms and
 *                            no failure); otherwise measured only
 */
const RATE = Math.max(1, Math.floor(Number(__ENV.POSITIONS_5M_RATE || 500)));
const POINTS = Math.min(
  200,
  Math.max(1, Math.floor(Number(__ENV.POSITIONS_5M_POINTS || 4))),
);
const DURATION = __ENV.POSITIONS_5M_DURATION || "10m";
const MAX_VUS = Math.max(
  1,
  Math.floor(Number(__ENV.POSITIONS_5M_MAX_VUS || 2000)),
);
const ARM = __ENV.POSITIONS_5M_ARM || "";
const ACCEPTANCE = __ENV.POSITIONS_5M_ACCEPTANCE === "true";

/** The app of contract 8 (F2-27), the one in the field at the gate. */
const CONTRACT = 8;

const DRIVERS = Math.max(1, context.driverTokens.length);

const sent = new Counter("positions_points_sent");
const stored = new Counter("positions_points_stored");
const rejected = new Counter("positions_points_rejected");

export const options = {
  summaryTrendStats: SUMMARY_TREND_STATS,

  scenarios: {
    fleet: {
      executor: "constant-arrival-rate",
      rate: RATE,
      timeUnit: "1s",
      duration: DURATION,
      preAllocatedVUs: Math.min(MAX_VUS, RATE),
      maxVUs: MAX_VUS,
      gracefulStop: "30s",
      tags: ARM ? { arm: ARM } : {},
    },
  },

  thresholds: ACCEPTANCE
    ? {
        "surface_latency{surface:route.positions}": ["p(95)<150"],
        "surface_failures{surface:route.positions}": ["rate==0"],
        // The rate itself: a generator that could not keep up would pass
        // at whatever rate it reached.
        dropped_iterations: ["count==0"],
        positions_points_stored: ["count>0"],
      }
    : {
        "surface_latency{surface:route.positions}": ["p(95)>=0"],
        "surface_failures{surface:route.positions}": ["rate>=0"],
        "surface_throttled{surface:route.positions}": ["rate>=0"],
        "surface_shed{surface:route.positions}": ["rate>=0"],
        positions_points_sent: ["count>=0"],
        positions_points_stored: ["count>=0"],
        positions_points_rejected: ["count>=0"],
      },
};

export function setup() {
  return { from: new Date().toISOString() };
}

function storedOf(response) {
  try {
    const value = Number(response.json("data.stored"));
    const refused = Number(response.json("data.rejected"));

    return {
      stored: Number.isFinite(value) ? value : 0,
      rejected: Number.isFinite(refused) ? refused : 0,
    };
  } catch {
    return { stored: 0, rejected: 0 };
  }
}

export default function positions5m() {
  const driver = exec.scenario.iterationInTest % DRIVERS;
  const response = surfaces.flushPositions(driver, CONTRACT, POINTS);

  sent.add(POINTS);

  if (response.status === 200) {
    const counts = storedOf(response);

    stored.add(counts.stored);
    rejected.add(counts.rejected);
  }
}

export function teardown(data) {
  // The oldest point of a flush is POINTS × 15 s before its POST
  // (lib/api.js, pingsEndingNow): the window starts that much earlier.
  const from = new Date(
    new Date(data.from).getTime() - POINTS * 15_000 - 1_000,
  ).toISOString();

  console.log(
    `POSITIONS_5M_WINDOW ${JSON.stringify({ from, to: new Date().toISOString(), arm: ARM, rate: RATE, points: POINTS })}`,
  );
}
