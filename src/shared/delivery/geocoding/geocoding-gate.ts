import { randomUUID } from "node:crypto";

import type { Redis } from "ioredis";

import { env } from "@/env";

import { GEOCODING_KEYS, type GeocodingKeys } from "./geocoding-keys";
import {
  GEOCODING_BACKGROUND_CALLS_PER_MINUTE_DEFAULT,
  GEOCODING_CALLS_PER_MINUTE_DEFAULT,
  GEOCODING_CALLS_PER_SECOND_DEFAULT,
} from "./geocoding-rules";

/**
 * When the geocoder may call the provider at all, across every replica and
 * every path — the minute's job, the lookup a request starts after its
 * commit (geocode-soon.ts) and the panel's address search
 * (search-address-usecase.ts). Two answers, both in Redis, both failing
 * CLOSED like the budget (geocoding-budget.ts): a lookup put off costs a
 * minute, one the provider refuses costs a delivery's attempt or the quota.
 *
 * - The pause: the provider refused the request (a bad key, a wrong URL) or
 *   limited it (429). Every replica stops asking until it ends — 15 min for
 *   a refusal, the next UTC midnight for the day's quota, a minute for a
 *   burst — instead of burning the open deliveries' attempts on an answer
 *   that is about the account, not the address. The key keeps the reason
 *   beside the deadline, so the route read can tell a pause that holds the
 *   lookups for long from a minute's (geocoding-hold.ts). A QUOTA or a
 *   BURST is the account's and holds the search too; a refusal of the
 *   search's own endpoint pauses only the search (address-search-limits.ts),
 *   never the deliveries' lookups.
 * - The slot: at most GEOCODING_CALLS_PER_SECOND calls in a second (a fixed
 *   window) and GEOCODING_CALLS_PER_MINUTE in any 60 s (a sliding log; the
 *   background paths stop sooner), shared by everybody — the job, the
 *   lookup after a commit and the search. The job's spacing only spaced
 *   one replica's run.
 */
interface GeocodingGate {
  /** Whether lookups are paused; true when Redis does not answer. */
  paused(now: Date): Promise<boolean>;

  /**
   * Pauses every replica until `until`; never shortens a longer pause.
   * `status` is the provider's HTTP answer that caused it, kept for the log
   * and the health page.
   */
  pause(
    until: Date,
    now: Date,
    reason: GeocodingPauseReason,
    status?: number | null,
  ): Promise<void>;

  /**
   * One call's slot in the current second and minute; false when either is
   * full or unknown.
   */
  takeSlot(): Promise<boolean>;
}

/**
 * Why the lookups are paused: the provider REFUSED the request, its daily
 * QUOTA is spent (429 "Rate Limited Day"), or a BURST went over its rate.
 */
type GeocodingPauseReason = "REFUSED" | "QUOTA" | "BURST";

const PAUSE_REASONS: ReadonlySet<string> = new Set([
  "REFUSED",
  "QUOTA",
  "BURST",
]);

/**
 * The defaults of the three ceilings (geocoding-rules.ts: LocationIQ's free
 * tier); a process takes them from the env (geocodingRatesFromEnv), so a
 * paid plan raises them without a release (plano-escala F2-31).
 *
 * The minute is any 60 s, not the clock's minute: in fixed minutes, 50
 * calls at the end of one and 50 at the start of the next made 60 within a
 * minute at a call a second — the proofs' ten gone wherever the provider's
 * minute starts.
 */
const GEOCODING_CALLS_PER_SECOND = GEOCODING_CALLS_PER_SECOND_DEFAULT;
const GEOCODING_CALLS_PER_MINUTE = GEOCODING_CALLS_PER_MINUTE_DEFAULT;
const GEOCODING_BACKGROUND_CALLS_PER_MINUTE =
  GEOCODING_BACKGROUND_CALLS_PER_MINUTE_DEFAULT;

/** The ceilings a gate is built with, as the process's env sets them. */
interface GeocodingRates {
  /** Calls in one second, every path but the proof's. */
  perSecond: number;
  /** The search's ceiling in any 60 s. */
  perMinute: number;
  /** The job's and the lookup after a commit's, below the search's. */
  backgroundPerMinute: number;
}

function geocodingRatesFromEnv(
  source: Pick<
    typeof env,
    | "GEOCODING_CALLS_PER_SECOND"
    | "GEOCODING_CALLS_PER_MINUTE"
    | "GEOCODING_BACKGROUND_CALLS_PER_MINUTE"
  > = env,
): GeocodingRates {
  return {
    perSecond: source.GEOCODING_CALLS_PER_SECOND,
    perMinute: source.GEOCODING_CALLS_PER_MINUTE,
    backgroundPerMinute: source.GEOCODING_BACKGROUND_CALLS_PER_MINUTE,
  };
}

const MINUTE_MS = 60_000;

/**
 * "REFUSED 2026-11-09T15:15:00.000Z 401": the reason, the deadline and,
 * when known, the provider's HTTP status that caused it. The status is a
 * third token so the replicas before it, which read only the first two
 * (`split(" ", 2)`), read a new value the same way; a value they wrote has
 * no status, and reads as such.
 */
function pauseValue(
  reason: GeocodingPauseReason,
  until: Date,
  status?: number | null,
): string {
  const base = `${reason} ${until.toISOString()}`;

  return status ? `${base} ${status}` : base;
}

/** The reason a pause key holds; null for no key or a value of no reason. */
function pauseReasonOf(
  value: string | null | undefined,
): GeocodingPauseReason | null {
  const reason = value?.split(" ", 1)[0] ?? "";

  return PAUSE_REASONS.has(reason) ? (reason as GeocodingPauseReason) : null;
}

/** The deadline a pause key holds; null for no key or a value without one. */
function pauseDeadlineOf(value: string | null | undefined): Date | null {
  const deadline = new Date(value?.split(" ", 2)[1] ?? "");

  return Number.isNaN(deadline.getTime()) ? null : deadline;
}

/** The HTTP status a pause key holds; null for none or an older value. */
function pauseStatusOf(value: string | null | undefined): number | null {
  const token = value?.split(" ", 3)[2] ?? "";

  if (!/^\d{3}$/.test(token)) return null;

  const status = Number(token);

  return status >= 100 && status <= 599 ? status : null;
}

/** Two seconds, so a window's key outlives its second. */
const SLOT_WINDOW_SECONDS = 2;

/**
 * A slot in the second AND the last 60 s, or in neither, in one script: a
 * call refused for the minute must not spend the second's slot, and a
 * background call refused at its ceiling must not enter the minute's log,
 * or its retries would eat the tail the search keeps. The second's window
 * is armed like countInFixedWindow's (fixed-window-counter.ts); the
 * minute's log (a sorted set) drops what is 60 s old before it counts,
 * gets the call's time when it grants, and expires a minute after the
 * last call.
 *
 * KEYS: the second's window, the minute's log. ARGV: the second's ceiling,
 * the minute's, the second's TTL (s), now (ms), the minute (ms), the
 * call's member.
 *
 * Read before the INCR, unlike the replicas before the minute's log, which
 * INCR the second's key and compare after: an old replica's refused try
 * leaves the count above the ceiling, which this reads as full, so the two
 * count the same second during a rolling deploy.
 */
const TAKE_SLOT = [
  "local second = tonumber(redis.call('GET', KEYS[1]) or '0')",
  "if second >= tonumber(ARGV[1]) then",
  "  return 0",
  "end",
  "local now = tonumber(ARGV[4])",
  "local window = tonumber(ARGV[5])",
  "redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now - window)",
  "if redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[2]) then",
  "  return 0",
  "end",
  "redis.call('INCR', KEYS[1])",
  "if redis.call('PTTL', KEYS[1]) == -1 then",
  "  redis.call('EXPIRE', KEYS[1], ARGV[3])",
  "end",
  "redis.call('ZADD', KEYS[2], now, ARGV[6])",
  "redis.call('PEXPIRE', KEYS[2], window)",
  "return 1",
].join("\n");

/**
 * SET with the new deadline only when the key has none, or an earlier one:
 * a burst's minute must not cut short a pause until midnight. One script,
 * so two replicas pausing at once cannot interleave the read and the write.
 */
const EXTEND_PAUSE = [
  "local left = redis.call('PTTL', KEYS[1])",
  "if left < tonumber(ARGV[2]) then",
  "  redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])",
  "end",
  "return 1",
].join("\n");

function createRedisGeocodingGate(
  redis: Pick<Redis, "eval" | "get">,
  {
    perSecond = GEOCODING_CALLS_PER_SECOND,
    perMinute = GEOCODING_BACKGROUND_CALLS_PER_MINUTE,
    clock = () => Date.now(),
    onError = () => undefined,
    keys = GEOCODING_KEYS,
  }: {
    perSecond?: number;
    perMinute?: number;
    clock?: () => number;
    onError?: (err: unknown) => void;
    /** Production's unless a test runs the gate on keys of its own. */
    keys?: GeocodingKeys;
  } = {},
): GeocodingGate {
  return {
    async paused() {
      try {
        return (await redis.get(keys.pause)) !== null;
      } catch (err) {
        onError(err);

        return true;
      }
    },

    async pause(until, now, reason, status) {
      const ms = Math.ceil(until.getTime() - now.getTime());

      if (ms <= 0) return;

      try {
        await redis.eval(
          EXTEND_PAUSE,
          1,
          keys.pause,
          pauseValue(reason, until, status),
          ms,
        );
      } catch (err) {
        onError(err);
      }
    },

    async takeSlot() {
      try {
        const now = clock();
        const granted = await redis.eval(
          TAKE_SLOT,
          2,
          keys.second(Math.floor(now / 1000)),
          keys.minute,
          perSecond,
          perMinute,
          SLOT_WINDOW_SECONDS,
          now,
          MINUTE_MS,
          // Two calls of one millisecond are two members.
          `${now}:${randomUUID()}`,
        );

        return Number(granted) === 1;
      } catch (err) {
        onError(err);

        return false;
      }
    },
  };
}

export {
  EXTEND_PAUSE,
  GEOCODING_BACKGROUND_CALLS_PER_MINUTE,
  GEOCODING_CALLS_PER_MINUTE,
  GEOCODING_CALLS_PER_SECOND,
  MINUTE_MS,
  TAKE_SLOT,
  createRedisGeocodingGate,
  geocodingRatesFromEnv,
  pauseDeadlineOf,
  pauseReasonOf,
  pauseStatusOf,
  pauseValue,
};
export type { GeocodingGate, GeocodingPauseReason, GeocodingRates };
