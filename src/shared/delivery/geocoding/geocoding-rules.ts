/**
 * The geocoding queue's numbers (plan of 02/11/2026, E1), apart from the
 * SQL so the twin, the route read (address-lookup-state.ts) and the tests
 * read the same ones without a database.
 */

/**
 * Claims stop after this many: an address the provider failed on eight
 * times, over about twenty hours, is left for a person (the route map's
 * "Fixar no mapa"). It was five, with a linear back-off: an outage of two
 * and a half hours exhausted every open delivery.
 */
const GEOCODING_MAX_ATTEMPTS = 8;

/**
 * The back-off after a failure, doubling from 15 min per attempt already
 * made and capped at 6 h: 15, 30, 60, 120, 240, 360, 360. Also the lease of
 * a claim whose replica died.
 */
const GEOCODING_BACKOFF_MINUTES = 15;
const GEOCODING_BACKOFF_CAP_MINUTES = 360;

/** The minutes a delivery with `attempts` made waits before the next claim. */
function geocodingBackoffMinutes(attempts: number): number {
  return Math.min(
    GEOCODING_BACKOFF_MINUTES * 2 ** Math.max(attempts - 1, 0),
    GEOCODING_BACKOFF_CAP_MINUTES,
  );
}

/**
 * The provider's rate as the gate shares it (geocoding-gate.ts), by default:
 * LocationIQ's free tier, 2 calls a second and 60 a minute for the account.
 * One call a second for the job, the lookup after a commit and the search;
 * the other is the proof's reverse lookup (proof-location-service.ts).
 * GEOCODING_CALLS_PER_SECOND in the env (plano-escala F2-31).
 */
const GEOCODING_CALLS_PER_SECOND_DEFAULT = 1;

/**
 * The free tier's other ceiling: 60 calls a minute, the whole account. A
 * call a second already makes 60, and the proof's reverse lookups come on
 * top: the gated calls stop at 50 in any 60 s, leaving ten to the proofs.
 * Without it the 61st call met a 429, the BURST pause, and every path
 * stopped for a minute. GEOCODING_CALLS_PER_MINUTE in the env.
 */
const GEOCODING_CALLS_PER_MINUTE_DEFAULT = 50;

/**
 * Where the job and the lookup after a commit stop, on the same log: the
 * last ten of the 60 s are the search's, which a person is waiting on. A
 * run asks 40 at most (20 claims, two queries each).
 * GEOCODING_BACKGROUND_CALLS_PER_MINUTE in the env; never above the
 * search's (the env schema refuses it).
 */
const GEOCODING_BACKGROUND_CALLS_PER_MINUTE_DEFAULT = 40;

/** Deliveries one claim of the job takes (DELIVERY_GEOCODING_BATCH_SIZE). */
const GEOCODING_BATCH_SIZE_DEFAULT = 20;

/**
 * How long the minute's job keeps claiming while each claim comes back
 * full (DELIVERY_GEOCODING_RUN_BUDGET_MS): under the minute, so a run is
 * over before the next one starts on another replica, with room for the
 * calls in flight.
 */
const GEOCODING_RUN_BUDGET_DEFAULT_MS = 50_000;
const GEOCODING_RUN_BUDGET_MAX_MS = 55_000;

/**
 * The proof's reverse lookup (plano-escala F2-32): one call a second of its
 * own (GEOCODING_PROOF_RESERVED_PER_SECOND), the free tier's second call,
 * which it had to itself before it was counted; and 1,500 lookups a UTC
 * day (PROOF_REVERSE_DAILY_BUDGET), so the free tier's 5,000 keep a 10%
 * margin with the job's 2,000 and the search's 1,000.
 */
const GEOCODING_PROOF_RESERVED_PER_SECOND_DEFAULT = 1;
const PROOF_REVERSE_DAILY_BUDGET_DEFAULT = 1_500;

/** What the geocoder may spend of the provider's plan, and the plan. */
interface GeocodingPlanSettings {
  GEOCODING_CALLS_PER_SECOND: number;
  GEOCODING_PROOF_RESERVED_PER_SECOND: number;
  DELIVERY_GEOCODING_DAILY_BUDGET: number;
  ADDRESS_SEARCH_DAILY_BUDGET: number;
  PROOF_REVERSE_DAILY_BUDGET: number;
  LOCATIONIQ_RATE_PER_SECOND?: number;
  LOCATIONIQ_DAILY_QUOTA?: number;
}

/**
 * Where the geocoder's rates and budgets pass 90% of the plan the owner
 * wrote down (decision D40), one problem per side; none when the plan is
 * not written. The rates a second are the gated paths' and the proof's;
 * the day is the job's, the search's and the proof's — the same account,
 * so a burst or a late day still meets no 429. Compared in tenths, with
 * whole numbers: 0.9 is not exact in a double, and 18 calls of a plan of
 * 20 must pass.
 */
function geocodingPlanProblems(
  settings: GeocodingPlanSettings,
): Array<{ path: string; message: string }> {
  const problems: Array<{ path: string; message: string }> = [];
  const rate = settings.LOCATIONIQ_RATE_PER_SECOND;
  const quota = settings.LOCATIONIQ_DAILY_QUOTA;

  if (rate !== undefined) {
    const spent =
      settings.GEOCODING_CALLS_PER_SECOND +
      settings.GEOCODING_PROOF_RESERVED_PER_SECOND;

    if (spent * 10 > rate * 9) {
      problems.push({
        path: "LOCATIONIQ_RATE_PER_SECOND",
        message: `GEOCODING_CALLS_PER_SECOND + GEOCODING_PROOF_RESERVED_PER_SECOND = ${spent} passa de 90% de LOCATIONIQ_RATE_PER_SECOND (${rate}): no máximo ${Math.floor((rate * 9) / 10)} por segundo.`,
      });
    }
  }

  if (quota !== undefined) {
    const spent =
      settings.DELIVERY_GEOCODING_DAILY_BUDGET +
      settings.ADDRESS_SEARCH_DAILY_BUDGET +
      settings.PROOF_REVERSE_DAILY_BUDGET;

    if (spent * 10 > quota * 9) {
      problems.push({
        path: "LOCATIONIQ_DAILY_QUOTA",
        message: `DELIVERY_GEOCODING_DAILY_BUDGET + ADDRESS_SEARCH_DAILY_BUDGET + PROOF_REVERSE_DAILY_BUDGET = ${spent} passa de 90% de LOCATIONIQ_DAILY_QUOTA (${quota}): no máximo ${Math.floor((quota * 9) / 10)} por dia.`,
      });
    }
  }

  return problems;
}

export {
  GEOCODING_BACKGROUND_CALLS_PER_MINUTE_DEFAULT,
  GEOCODING_BACKOFF_CAP_MINUTES,
  GEOCODING_BACKOFF_MINUTES,
  GEOCODING_BATCH_SIZE_DEFAULT,
  GEOCODING_CALLS_PER_MINUTE_DEFAULT,
  GEOCODING_CALLS_PER_SECOND_DEFAULT,
  GEOCODING_MAX_ATTEMPTS,
  GEOCODING_PROOF_RESERVED_PER_SECOND_DEFAULT,
  GEOCODING_RUN_BUDGET_DEFAULT_MS,
  GEOCODING_RUN_BUDGET_MAX_MS,
  PROOF_REVERSE_DAILY_BUDGET_DEFAULT,
  geocodingBackoffMinutes,
  geocodingPlanProblems,
};
export type { GeocodingPlanSettings };
