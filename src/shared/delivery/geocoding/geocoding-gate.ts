import type { Redis } from "ioredis";

import { countInFixedWindow } from "@/shared/services/fixed-window-counter";

/**
 * When the geocoder may call the provider at all, across every replica and
 * both paths — the minute's job and the lookup a request starts after its
 * commit (geocode-soon.ts). Two answers, both in Redis, both failing CLOSED
 * like the budget (geocoding-budget.ts): a lookup put off costs a minute,
 * one the provider refuses costs a delivery's attempt or the quota.
 *
 * - The pause: the provider refused the request (a bad key, a wrong URL) or
 *   limited it (429). Every replica stops asking until it ends — 15 min for
 *   a refusal, the next UTC midnight for the day's quota, a minute for a
 *   burst — instead of burning the open deliveries' attempts on an answer
 *   that is about the account, not the address. The key keeps the reason
 *   beside the deadline, so the route read can tell a pause that holds the
 *   lookups for long from a minute's (geocoding-hold.ts).
 * - The slot: at most GEOCODING_CALLS_PER_SECOND calls in a second, in one
 *   fixed window per second shared by everybody. The job's spacing only
 *   spaced one replica's run.
 */
interface GeocodingGate {
  /** Whether lookups are paused; true when Redis does not answer. */
  paused(now: Date): Promise<boolean>;

  /** Pauses every replica until `until`; never shortens a longer pause. */
  pause(until: Date, now: Date, reason: GeocodingPauseReason): Promise<void>;

  /** One call's slot in the current second; false when full or unknown. */
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
 * One of the provider's two calls a second (LocationIQ's free tier). The
 * other is left to the proof's reverse lookup (proof-location-service),
 * which shares the key and the rate and is not counted here: a proof that
 * met a 429 would print without its address for a day.
 */
const GEOCODING_CALLS_PER_SECOND = 1;

const PAUSE_KEY = "geocoding:deliveries:paused";

/** "REFUSED 2026-11-09T15:15:00.000Z": the reason, then the deadline. */
function pauseValue(reason: GeocodingPauseReason, until: Date): string {
  return `${reason} ${until.toISOString()}`;
}

/** The reason a pause key holds; null for no key or a value of no reason. */
function pauseReasonOf(
  value: string | null | undefined,
): GeocodingPauseReason | null {
  const reason = value?.split(" ", 1)[0] ?? "";

  return PAUSE_REASONS.has(reason) ? (reason as GeocodingPauseReason) : null;
}

/** Two seconds, so a window's key outlives its second. */
const SLOT_WINDOW_SECONDS = 2;

function slotKey(epochSecond: number): string {
  return `geocoding:deliveries:rate:${epochSecond}`;
}

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
    clock = () => Date.now(),
    onError = () => undefined,
  }: {
    perSecond?: number;
    clock?: () => number;
    onError?: (err: unknown) => void;
  } = {},
): GeocodingGate {
  return {
    async paused() {
      try {
        return (await redis.get(PAUSE_KEY)) !== null;
      } catch (err) {
        onError(err);

        return true;
      }
    },

    async pause(until, now, reason) {
      const ms = Math.ceil(until.getTime() - now.getTime());

      if (ms <= 0) return;

      try {
        await redis.eval(
          EXTEND_PAUSE,
          1,
          PAUSE_KEY,
          pauseValue(reason, until),
          ms,
        );
      } catch (err) {
        onError(err);
      }
    },

    async takeSlot() {
      try {
        const count = await countInFixedWindow(
          redis,
          slotKey(Math.floor(clock() / 1000)),
          SLOT_WINDOW_SECONDS,
        );

        return count <= perSecond;
      } catch (err) {
        onError(err);

        return false;
      }
    },
  };
}

export {
  EXTEND_PAUSE,
  GEOCODING_CALLS_PER_SECOND,
  PAUSE_KEY,
  createRedisGeocodingGate,
  pauseReasonOf,
  pauseValue,
  slotKey,
};
export type { GeocodingGate, GeocodingPauseReason };
