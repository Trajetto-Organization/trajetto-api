import { sleep } from "k6";
import { Counter, Trend } from "k6/metrics";

import {
  SUMMARY_TREND_STATS,
  context,
  retryAfterOf,
  surfaces,
} from "./lib/api.js";

/**
 * The fleet's GPS, the heaviest write on the platform, the way the phones
 * really send it (plano-escala LOAD-03).
 *
 * The mix (lib/mix.js) asks for positions as one weight among others, from
 * whatever VU drew the ticket. Here every VU is ONE driver with its own
 * token, and does what the app of contract 8 does (F2-27): a flush of the
 * minute's points, then the larger of its own minute and the
 * `nextFlushAfterMs` the answer asked for (F2-26: 60 s, 120 s under
 * pressure, 300 s at the limit), clamped to [1 min, 5 min] like the app; a
 * refused flush waits the backoff and never less than Retry-After. So the
 * POST/s this scene produces is the fleet's and not the harness': N drivers
 * over their interval, and it drops by itself when the API asks. The
 * ruler's ~333 POST/s at the 5M step is twenty thousand drivers
 * (LOAD_PRIMARY_DRIVERS); 1,000 POST/s, sixty thousand.
 *
 *   POSITIONS_DRIVERS   drivers (VUs), up to the fixture's tokens
 *   POSITIONS_DURATION  how long (10m)
 *   POSITIONS_CONTRACT  the app contract the header says (8; 7 sends the
 *                       old app's flush without the hint, for comparison)
 */
const DRIVERS = Math.max(
  1,
  Math.min(
    Number(__ENV.POSITIONS_DRIVERS || context.driverTokens.length),
    context.driverTokens.length,
  ),
);

const CONTRACT = Number(__ENV.POSITIONS_CONTRACT || 8);

/** The app's own interval, and the range it holds the server's hint to. */
const APP_INTERVAL_MS = 60_000;
const SERVER_INTERVAL_MAX_MS = 5 * 60_000;

/**
 * One point every 15 s; never more than one request's worth (200) per
 * flush, and never more than the app's buffer (900) waiting.
 */
const POINTS_PER_MINUTE = 4;
const MAX_BATCH = 200;
const MAX_BUFFER = 900;

/** The app's backoff (F2-27): 15 s doubling to 5 min, times U(0.5, 1.5). */
const BACKOFF_BASE_MS = 15_000;
const BACKOFF_MAX_MS = 5 * 60_000;

const hints = new Trend("positions_next_flush_ms");
const waits = new Trend("positions_wait_ms");
const posts = new Counter("positions_posts");

export const options = {
  summaryTrendStats: SUMMARY_TREND_STATS,

  scenarios: {
    fleet: {
      executor: "constant-vus",
      vus: DRIVERS,
      duration: __ENV.POSITIONS_DURATION || "10m",
      // A driver mid-wait is not cut: it just does not send again.
      gracefulStop: "10s",
    },
  },

  thresholds: {
    "surface_latency{surface:route.positions}": ["p(95)<800", "p(99)<2000"],
    "surface_failures{surface:route.positions}": ["rate<0.01"],
    "surface_throttled{surface:route.positions}": ["rate>=0"],
    "surface_shed{surface:route.positions}": ["rate>=0"],

    // What the API asked and what the phones waited: the summary-export
    // carries both, so a report says whether the fleet slowed down when
    // asked.
    positions_next_flush_ms: ["max>=0"],
    positions_wait_ms: ["max>=0"],
    positions_posts: ["count>=0"],
  },
};

// Per VU: k6 runs each VU in a runtime of its own, so this is one phone.
let started = false;
let failures = 0;
let buffered = POINTS_PER_MINUTE;

function hintOf(response) {
  try {
    const hint = Number(response.json("nextFlushAfterMs"));

    return Number.isFinite(hint) && hint >= 0 ? hint : null;
  } catch {
    return null;
  }
}

export default function positions() {
  // The fleet does not start in one second: each phone's first flush lands
  // somewhere in the first minute, as a morning's do.
  if (!started) {
    started = true;
    sleep((Math.random() * APP_INTERVAL_MS) / 1000);
  }

  const batch = Math.min(MAX_BATCH, Math.max(1, Math.floor(buffered)));
  const response = surfaces.flushPositions(__VU - 1, CONTRACT, batch);

  posts.add(1);

  let waitMs;

  if (response.status === 200) {
    failures = 0;
    buffered = Math.max(0, buffered - batch);

    const hint = hintOf(response);

    if (hint !== null) hints.add(hint);

    // Contract 7 never read the hint; contract 8 waits the larger of the two.
    // A backlog left over goes in pieces, 0.5 to 2 s apart (F2-27).
    waitMs =
      buffered >= 1
        ? 500 + Math.random() * 1_500
        : CONTRACT >= 8 && hint !== null
          ? Math.min(SERVER_INTERVAL_MAX_MS, Math.max(APP_INTERVAL_MS, hint))
          : APP_INTERVAL_MS;
  } else {
    failures += 1;

    const backoff =
      Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (failures - 1)) *
      (0.5 + Math.random());
    const retryAfter = retryAfterOf(response);

    waitMs = Math.max(backoff, retryAfter === null ? 0 : retryAfter * 1000);
  }

  waits.add(waitMs);

  // What is left, plus the points recorded while waiting, is the next
  // flush's: a refused one stays in the buffer, as on the phone.
  buffered = Math.min(
    MAX_BUFFER,
    buffered + (POINTS_PER_MINUTE * waitMs) / APP_INTERVAL_MS,
  );

  sleep(waitMs / 1000);
}
