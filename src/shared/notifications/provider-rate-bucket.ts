import Redis from "ioredis";

import { redisClientOptions } from "@/config/redis-client-options";
import { env } from "@/env";
import { registerSampleSection } from "@/shared/health/ops-sample";
import { settlesWithin } from "@/shared/lifecycle/deadline";
import { logger } from "@/shared/logging/logger";
import { attachRedisConnectionLog } from "@/shared/services/redis-connection-log";

import {
  PROVIDER_LANE,
  PROVIDERS,
  providerCaps,
  type Provider,
} from "./provider-caps";

const log = logger.child({ component: "provider-rate-bucket" });

/**
 * The providers' RATE, platform-wide (plano-escala F3-15c; decision D45).
 *
 * The global caps of provider-caps.ts bound how many sends are in flight,
 * never how many leave in a second: four slots whose sends take 100 ms are
 * already ~40 requests a second against Resend's 10, and a fast Meta answers
 * a burst at whatever rate the slots free up. The contracts are rates — 80
 * messages a second at Meta, 10 requests at Resend, 600 notifications at
 * Expo — and one platform account serves every company, so going past them
 * is a 429 (or Meta's 130429) for everybody at once.
 *
 * A GCRA bucket per provider, in Redis, shared by every process: the key
 * holds the provider's theoretical arrival time (TAT), the moment the next
 * send may start, on Redis' own clock (TIME), so processes on different
 * hosts agree. A send reserves its place: it starts at max(TAT, now) and
 * moves the TAT one interval (1000 ms / rate) on, per unit it costs (a push
 * to three phones is three notifications). Sends are spaced, never bunched:
 * no more than `rate` start in any second. A place within MAX_WAIT_MS is
 * kept and the send waits for it in its slot; a place further ahead is not
 * taken, and the row goes back to the queue with availableAt at that place,
 * without spending an attempt (the pipeline's DeferredDeliveryError).
 *
 * A provider that still answers 429 (Meta's 130429, Resend's rate refusal,
 * Expo's 429) pushes the TAT to now + its pause: every process waits, not
 * only the one that heard it, and the row waits too, again without spending
 * an attempt.
 *
 * Off by default: WHATSAPP_SENDS_PER_SECOND, EMAIL_REQUESTS_PER_SECOND and
 * PUSH_NOTIFICATIONS_PER_SECOND are 0, which touches nothing — no Redis
 * connection, no wait, a 429 handled as before (an attempt, the backoff).
 * They are turned on when a 429 or a 130429 shows up (the provider-throttled
 * alert) or when the projected peak passes half the provider's limit.
 *
 * Redis down or hung: the F3-15a division stands in. Each process keeps a
 * bucket of its own at rate / the lane's stable divisor (the live processes
 * that claim the provider's lane, never shrinking on a hiccup), so together
 * they stay under the rate without Redis, and asks Redis again five seconds
 * later instead of paying its timeout on every send. Nothing here is business state:
 * the TAT is a pacing counter, and losing it costs at most one second of
 * the rate.
 */

/** How long a send may wait in its slot for its place. */
const MAX_WAIT_MS = 1_000;

/** A 429 without Retry-After holds the provider this long, at least. */
const THROTTLE_PAUSE_MS = 1_000;

/**
 * The longest a provider's Retry-After holds every process: a header that
 * asks for an hour stalls the whole platform's channel that long, so past a
 * minute the bucket waits a minute and the row keeps the rest (the
 * pipeline's own cap, MAX_RETRY_AFTER_MS).
 */
const MAX_PENALTY_MS = 60_000;

/**
 * After Redis failed, the local share answers this long before Redis is
 * asked again: a Redis that is away would otherwise cost every send its
 * command timeout (half a second, redis-client-options.ts).
 */
const REDIS_RETRY_MS = 5_000;

/** Production's keys, one per provider, shared by every process. */
const DEFAULT_NAMESPACE = "provider-rate";

type RateVerdict =
  /** No rate set for the provider: send as before. */
  | { kind: "off" }
  /** A place `waitMs` from now, already reserved. */
  | { kind: "go"; waitMs: number; local: boolean }
  /** No place within MAX_WAIT_MS: come back in `retryInMs`. */
  | { kind: "later"; retryInMs: number; local: boolean };

/**
 * The milliseconds between two units of `perSecond`, rounded up: the
 * bucket's TAT is an integer on Redis' clock, so a rate that does not
 * divide a second (60/s: 16.67 ms) leaves a little under it, never over.
 */
function emissionIntervalMs(perSecond: number): number {
  return Math.ceil(1000 / perSecond);
}

interface GcraAnswer {
  granted: boolean;
  /** How long until the place starts, from now. */
  waitMs: number;
  /** The TAT after the answer: moved only when granted. */
  tat: number;
}

/**
 * One take of a GCRA bucket with no burst: the place starts at max(TAT,
 * now) and the TAT moves `cost` intervals on. The Lua below is this, on
 * Redis' clock; the local bucket is this, on the process's.
 */
function gcraTake(
  tat: number,
  now: number,
  intervalMs: number,
  cost: number,
  maxWaitMs: number,
): GcraAnswer {
  const start = Math.max(tat, now);
  const waitMs = start - now;

  if (waitMs > maxWaitMs) return { granted: false, waitMs, tat };

  return { granted: true, waitMs, tat: start + intervalMs * cost };
}

/**
 * gcraTake in one script, on Redis' clock. KEYS: the provider's TAT. ARGV:
 * the interval (ms), the cost (units), the longest wait (ms). Answers
 * {granted, wait, start}: 1 with the place reserved, or 0 with the TAT
 * untouched. The key outlives the TAT by a second, so an idle provider
 * leaves nothing behind. Integers throughout, formatted by %.0f: Lua's
 * default %.14g would round a timestamp with a fraction.
 */
const TAKE_RATE = [
  "local clock = redis.call('TIME')",
  "local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)",
  "local tat = tonumber(redis.call('GET', KEYS[1]) or '0') or 0",
  "local start = math.max(tat, now)",
  "local wait = start - now",
  "if wait > tonumber(ARGV[3]) then",
  "  return {0, wait, start}",
  "end",
  "local after = start + tonumber(ARGV[1]) * tonumber(ARGV[2])",
  "redis.call('SET', KEYS[1], string.format('%.0f', after), 'PX', string.format('%.0f', after - now + 1000))",
  "return {1, wait, start}",
].join("\n");

/**
 * The provider asked us to slow down: its TAT moves to at least now + the
 * pause (ARGV[1], ms), never back. KEYS: the provider's TAT.
 */
const PENALIZE_RATE = [
  "local clock = redis.call('TIME')",
  "local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)",
  "local tat = tonumber(redis.call('GET', KEYS[1]) or '0') or 0",
  "local after = now + tonumber(ARGV[1])",
  "if tat < after then",
  "  redis.call('SET', KEYS[1], string.format('%.0f', after), 'PX', string.format('%.0f', tonumber(ARGV[1]) + 1000))",
  "end",
  "return 1",
].join("\n");

/** The bucket's key of a provider under a namespace. */
function rateKey(namespace: string, provider: Provider): string {
  return `${namespace}:${provider}`;
}

/** How long a throttled provider holds: its Retry-After, within reason. */
function throttlePauseMs(retryAfterMs: number | undefined): number {
  if (!retryAfterMs || !Number.isFinite(retryAfterMs) || retryAfterMs <= 0) {
    return THROTTLE_PAUSE_MS;
  }

  return Math.min(Math.max(retryAfterMs, THROTTLE_PAUSE_MS), MAX_PENALTY_MS);
}

type ProviderCounts = Record<Provider, number>;

const zeroCounts = (): ProviderCounts => ({ whatsapp: 0, email: 0, push: 0 });

/**
 * What the bucket and the providers did in the process's minute, into the
 * `provider_rate` section of its ops_sample row: the provider's own rate
 * refusals (counted with the bucket off too — they are what tells the owner
 * to turn it on: the provider-throttled alert sums them over 24 h), the
 * sends the bucket put off, and the takes the local share answered because
 * Redis did not.
 */
const counts = {
  throttled: zeroCounts(),
  deferred: zeroCounts(),
  local: zeroCounts(),
};

function countProviderThrottle(provider: Provider): void {
  counts.throttled[provider] += 1;
}

/** The minute's counts, reset; null when nothing happened. */
function takeProviderRateCounts(): {
  throttled: ProviderCounts;
  deferred: ProviderCounts;
  local: ProviderCounts;
} | null {
  const taken = {
    throttled: { ...counts.throttled },
    deferred: { ...counts.deferred },
    local: { ...counts.local },
  };

  counts.throttled = zeroCounts();
  counts.deferred = zeroCounts();
  counts.local = zeroCounts();

  const any = Object.values(taken).some((each) =>
    PROVIDERS.some((provider) => each[provider] > 0),
  );

  return any ? taken : null;
}

registerSampleSection("provider_rate", takeProviderRateCounts);

interface ProviderRateBucketDeps {
  /** Each provider's rate a second; 0 or less is off. */
  rates: () => Record<Provider, number>;

  /** The shared Redis, opened on first use. */
  redis: () => Pick<Redis, "eval">;

  /** The lane's stable divisor (F3-15a), for the local share. */
  divisor: (provider: Provider) => Promise<number>;

  /** The keys' namespace; production's unless an E2E run uses its own. */
  namespace?: () => string;

  /** The process's clock: the local share, and when to ask Redis again. */
  now?: () => number;

  maxWaitMs?: number;
}

function createProviderRateBucket(deps: ProviderRateBucketDeps) {
  const now = deps.now ?? Date.now;
  const maxWaitMs = deps.maxWaitMs ?? MAX_WAIT_MS;
  const namespace = deps.namespace ?? (() => DEFAULT_NAMESPACE);

  /** The local share's TAT per provider, on the process's clock. */
  const localTat = new Map<Provider, number>();

  let redisFailing = false;

  /** Until when Redis is not asked, after a failure. */
  let redisAwayUntil = 0;

  const rateOf = (provider: Provider): number => {
    const rate = deps.rates()[provider] ?? 0;

    return Number.isFinite(rate) && rate > 0 ? rate : 0;
  };

  const failed = (provider: Provider, error: unknown): void => {
    redisAwayUntil = now() + REDIS_RETRY_MS;

    if (!redisFailing) {
      redisFailing = true;
      log.warn(
        { provider, err: error },
        "provider rate bucket unreadable in Redis; each process keeps its share of the rate (rate / live processes of the lane)",
      );
    }
  };

  const recovered = (): void => {
    if (redisFailing) {
      redisFailing = false;
      log.info("provider rate bucket back on Redis");
    }
  };

  /** The F3-15a division: this process's share of the rate, locally. */
  const takeLocally = async (
    provider: Provider,
    rate: number,
    cost: number,
  ): Promise<RateVerdict> => {
    counts.local[provider] += 1;

    const divisor = Math.max(1, await deps.divisor(provider).catch(() => 1));
    const at = now();
    const answer = gcraTake(
      localTat.get(provider) ?? 0,
      at,
      1000 / (rate / divisor),
      cost,
      maxWaitMs,
    );

    if (!answer.granted) {
      counts.deferred[provider] += 1;

      return { kind: "later", retryInMs: answer.waitMs, local: true };
    }

    localTat.set(provider, answer.tat);

    return { kind: "go", waitMs: answer.waitMs, local: true };
  };

  return {
    /** Whether the provider's rate is on (its variable above 0). */
    enabled(provider: Provider): boolean {
      return rateOf(provider) > 0;
    },

    /**
     * A place for `cost` units of the provider's rate: off with no rate,
     * go after `waitMs` (reserved), or later.
     */
    async take(provider: Provider, cost = 1): Promise<RateVerdict> {
      const rate = rateOf(provider);

      if (rate === 0) return { kind: "off" };

      const units = Math.max(1, Math.floor(cost));

      if (now() < redisAwayUntil) return takeLocally(provider, rate, units);

      try {
        const answer = (await deps
          .redis()
          .eval(
            TAKE_RATE,
            1,
            rateKey(namespace(), provider),
            emissionIntervalMs(rate),
            units,
            maxWaitMs,
          )) as [number, number, number];

        recovered();

        const waitMs = Math.max(0, Number(answer[1]) || 0);

        if (Number(answer[0]) === 1) {
          return { kind: "go", waitMs, local: false };
        }

        counts.deferred[provider] += 1;

        return { kind: "later", retryInMs: waitMs, local: false };
      } catch (error) {
        failed(provider, error);

        return takeLocally(provider, rate, units);
      }
    },

    /**
     * The provider answered 429: every process waits `ms` before its next
     * send of it. The local share waits too, should Redis go next.
     */
    async penalize(provider: Provider, ms: number): Promise<void> {
      if (rateOf(provider) === 0 || !(ms > 0)) return;

      const pause = Math.min(Math.ceil(ms), MAX_PENALTY_MS);

      localTat.set(
        provider,
        Math.max(localTat.get(provider) ?? 0, now() + pause),
      );

      if (now() < redisAwayUntil) return;

      try {
        await deps
          .redis()
          .eval(PENALIZE_RATE, 1, rateKey(namespace(), provider), pause);

        recovered();
      } catch (error) {
        failed(provider, error);
      }
    },
  };
}

type ProviderRateBucket = ReturnType<typeof createProviderRateBucket>;

let client: Redis | null = null;

/** One connection per process, opened by the first take of a rate. */
function rateRedis(): Redis {
  if (client) return client;

  client = new Redis(env.REDIS_URL, redisClientOptions("provider-rate"));
  attachRedisConnectionLog(client, "provider-rate");

  return client;
}

let namespaceInUse = DEFAULT_NAMESPACE;

/**
 * An E2E run's own keys: its Redis outlives it and may serve another run
 * at the same time. Production never calls it.
 */
function useProviderRateNamespace(namespace: string): void {
  namespaceInUse = namespace;
}

/** This process's bucket, on the runtime's env, Redis and divisor. */
const providerRateBucket = createProviderRateBucket({
  rates: () => ({
    whatsapp: env.WHATSAPP_SENDS_PER_SECOND,
    email: env.EMAIL_REQUESTS_PER_SECOND,
    push: env.PUSH_NOTIFICATIONS_PER_SECOND,
  }),
  redis: rateRedis,
  divisor: (provider) => providerCaps.refresh(PROVIDER_LANE[provider]),
  namespace: () => namespaceInUse,
});

/**
 * On the way out, after the lanes stopped: the connection closed within
 * `deadlineMs` when the shutdown gives one. Never opened, nothing to do.
 */
async function closeProviderRateBucket(
  options: { deadlineMs?: number } = {},
): Promise<void> {
  const open = client;

  client = null;

  if (!open) return;

  let refused = false;
  const quitting = open.quit().catch(() => {
    refused = true;
  });

  const answered = await settlesWithin(
    quitting,
    options.deadlineMs ?? Infinity,
  );

  if (!answered || refused) open.disconnect();
}

export {
  MAX_PENALTY_MS,
  MAX_WAIT_MS,
  PENALIZE_RATE,
  REDIS_RETRY_MS,
  TAKE_RATE,
  THROTTLE_PAUSE_MS,
  closeProviderRateBucket,
  countProviderThrottle,
  createProviderRateBucket,
  emissionIntervalMs,
  gcraTake,
  providerRateBucket,
  rateKey,
  takeProviderRateCounts,
  throttlePauseMs,
  useProviderRateNamespace,
};
export type { ProviderRateBucket, ProviderRateBucketDeps, RateVerdict };
