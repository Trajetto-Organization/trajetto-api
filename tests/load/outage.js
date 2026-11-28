import { sleep } from "k6";
import exec from "k6/execution";
import { Counter } from "k6/metrics";

import {
  BASE,
  SUMMARY_TREND_STATS,
  breakdownOf,
  context,
  retryAfterOf,
  surfaces,
} from "./lib/api.js";
import { parseDuration } from "./lib/duration.js";

/**
 * Two minutes without the API, and the phones coming back (plano-escala
 * LOAD-03, X-24; the acceptance of the app's contract 8, F2-27).
 *
 * The app of contract 7 sent a failed flush again with the next fix, 15 s
 * later, on every phone at once, for as long as the API stayed down, and
 * then the whole backlog back to back: a fleet hammering a replica that was
 * trying to come back. Contract 8 waits 15 s doubling to 5 min, times
 * U(0.5, 1.5), never less than Retry-After, and sends a backlog in pieces of
 * 200 points 0.5 to 2 s apart. Each VU here is one phone of one contract,
 * with its own driver's token, and the attempts are counted by stage:
 * `base` (before), `down` (the 2 minutes), `after60` (the first minute
 * back) and `after`. The acceptance (lib/verdicts.mjs, outageVerdict, with
 * ≥ 90% of contract 8): the POST/s at most 1.2× the base while down and
 * 1.5× in the minute after.
 *
 * The outage: with OUTAGE_MODE=simulated (the default) the phones send to
 * OUTAGE_URL during the window, a closed port that refuses at once, the way
 * a replica that is not there does; with OUTAGE_MODE=external the scene
 * keeps sending to the API and something else takes it down for the window
 * (`docker compose stop` of the replicas, failure-injection.sh), at the
 * times the setup prints.
 *
 *   OUTAGE_PHONES          phones (VUs), up to the fixture's driver tokens
 *   OUTAGE_CONTRACT        7, 8 or mixed (the default)
 *   OUTAGE_CONTRACT8_SHARE with mixed, the share of contract 8 (0.9)
 *   OUTAGE_BASE            before the outage (2m)
 *   OUTAGE_DOWN            the outage (2m)
 *   OUTAGE_AFTER           after it (3m)
 *   OUTAGE_MODE            simulated | external
 *   OUTAGE_URL             where the simulated outage sends (http://127.0.0.1:9)
 */
const PHONES = Math.max(
  1,
  Math.min(
    Number(__ENV.OUTAGE_PHONES || context.driverTokens.length),
    context.driverTokens.length,
  ),
);

const MODE = __ENV.OUTAGE_CONTRACT || "mixed";
const SHARE_8 = Number(__ENV.OUTAGE_CONTRACT8_SHARE ?? 0.9);

const BASE_MS = parseDuration(__ENV.OUTAGE_BASE || "2m");
const DOWN_MS = parseDuration(__ENV.OUTAGE_DOWN || "2m");
const AFTER_MS = parseDuration(__ENV.OUTAGE_AFTER || "3m");

const FIRST_AFTER_MS = 60_000;

const SIMULATED = (__ENV.OUTAGE_MODE || "simulated") !== "external";
const OUTAGE_URL = __ENV.OUTAGE_URL || "http://127.0.0.1:9";

const APP_INTERVAL_MS = 60_000;
const RETRY_FIXED_MS = 15_000;
const BACKOFF_BASE_MS = 15_000;
const BACKOFF_MAX_MS = 5 * 60_000;
const SERVER_INTERVAL_MAX_MS = 5 * 60_000;

const POINTS_PER_MINUTE = 4;
const MAX_BATCH = 200;
const MAX_BUFFER = 900;

/** Every flush attempt, reached the API or not, by stage and contract. */
const attempts = new Counter("outage_attempts");

const STAGES = ["base", "down", "after60", "after"];

export const options = {
  summaryTrendStats: SUMMARY_TREND_STATS,

  scenarios: {
    phones: {
      executor: "constant-vus",
      vus: PHONES,
      duration: `${BASE_MS + DOWN_MS + AFTER_MS}ms`,
      gracefulStop: "10s",
    },
  },

  thresholds: {
    ...breakdownOf("stage", STAGES),

    // The counts the verdict divides by each stage's length.
    ...Object.fromEntries(
      STAGES.flatMap((stage) => [
        [`outage_attempts{stage:${stage}}`, ["count>=0"]],
        [`outage_attempts{stage:${stage},contract:7}`, ["count>=0"]],
        [`outage_attempts{stage:${stage},contract:8}`, ["count>=0"]],
      ]),
    ),

    // Before and well after the outage, a flush works.
    "surface_failures{stage:base}": ["rate<0.01"],
    "surface_failures{stage:after}": ["rate<0.05"],

    "surface_latency{surface:route.positions}": ["max>=0"],
  },
};

export function setup() {
  if (!SIMULATED) {
    console.log(
      `outage.js (external): derrube a API de ${BASE_MS / 1000} s a ${(BASE_MS + DOWN_MS) / 1000} s depois do início e suba de volta.`,
    );
  }
}

function stageOf(elapsedMs) {
  if (elapsedMs < BASE_MS) return "base";
  if (elapsedMs < BASE_MS + DOWN_MS) return "down";
  if (elapsedMs < BASE_MS + DOWN_MS + FIRST_AFTER_MS) return "after60";

  return "after";
}

/** The phones of contract 8 come first, so the share is exact. */
function contractOf(index) {
  if (MODE === "7") return 7;
  if (MODE === "8") return 8;

  return index < Math.round(PHONES * SHARE_8) ? 8 : 7;
}

function hintOf(response) {
  try {
    const hint = Number(response.json("nextFlushAfterMs"));

    return Number.isFinite(hint) && hint >= 0 ? hint : null;
  } catch {
    return null;
  }
}

// Per VU: one phone.
let phone = null;

export default function outage() {
  if (!phone) {
    phone = {
      index: __VU - 1,
      contract: contractOf(__VU - 1),
      buffered: POINTS_PER_MINUTE,
      failures: 0,
    };

    // A fleet's flushes are spread over the minute, before anything breaks.
    sleep((Math.random() * APP_INTERVAL_MS) / 1000);
  }

  const elapsed = exec.instance.currentTestRunDuration;
  const stage = stageOf(elapsed);
  const tags = { stage, contract: String(phone.contract) };

  const target = SIMULATED && stage === "down" ? OUTAGE_URL : BASE;
  const batch = Math.min(MAX_BATCH, Math.max(1, Math.floor(phone.buffered)));

  attempts.add(1, tags);

  const response = surfaces.flushPositions(
    phone.index,
    phone.contract,
    batch,
    tags,
    target,
  );

  let waitMs;

  if (response.status === 200) {
    phone.failures = 0;
    phone.buffered = Math.max(0, phone.buffered - batch);

    const hint = phone.contract >= 8 ? hintOf(response) : null;

    if (phone.buffered >= 1) {
      // The backlog: back to back on contract 7, pieces 0.5–2 s apart on 8.
      waitMs = phone.contract >= 8 ? 500 + Math.random() * 1_500 : 0;
    } else {
      waitMs =
        hint !== null
          ? Math.min(SERVER_INTERVAL_MAX_MS, Math.max(APP_INTERVAL_MS, hint))
          : APP_INTERVAL_MS;
    }
  } else {
    phone.failures += 1;

    if (phone.contract >= 8) {
      const backoff =
        Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (phone.failures - 1)) *
        (0.5 + Math.random());
      const retryAfter = retryAfterOf(response);

      waitMs = Math.max(backoff, retryAfter === null ? 0 : retryAfter * 1000);
    } else {
      // Contract 7: again with the next fix, on every phone at once.
      waitMs = RETRY_FIXED_MS;
    }
  }

  // The points recorded meanwhile stay in the buffer, up to the app's cap.
  phone.buffered = Math.min(
    MAX_BUFFER,
    phone.buffered + (POINTS_PER_MINUTE * waitMs) / APP_INTERVAL_MS,
  );

  if (waitMs > 0) sleep(waitMs / 1000);
}
