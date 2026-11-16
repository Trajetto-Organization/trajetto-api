import Redis from "ioredis";

import { env } from "@/env";
import { redisClientOptions } from "@/config/redis-client-options";
import { settlesWithin } from "@/shared/lifecycle/deadline";
import { isDraining } from "@/shared/lifecycle/draining";
import { logger } from "@/shared/logging/logger";
import { attachRedisConnectionLog } from "@/shared/services/redis-connection-log";
import { proofLocationConfigFromEnv } from "@/shared/services/proof-location/proof-location-service";
import { geocodeAddress } from "@/shared/services/proof-location/address-geocoder";

import { announceSettledLookups } from "./geocoding-announcer";
import {
  ProviderQuotaRepository,
  quotaDay,
  type IProviderQuotaRepository,
} from "@/shared/services/provider-quota/provider-quota-repository";

import {
  GEOCODER_PROVIDER,
  GEOCODING_SCOPES,
  countOf,
  createGeocodingBudget,
} from "./geocoding-budget";
import {
  createRedisGeocodingGate,
  geocodingRatesFromEnv,
  pauseDeadlineOf,
  pauseReasonOf,
  pauseStatusOf,
} from "./geocoding-gate";
import { GEOCODING_KEYS } from "./geocoding-keys";
import { DeliveryGeocodingRepository } from "./geocoding-repository";
import {
  DeliveryGeocodingService,
  nextUtcMidnight,
  spacingFor,
  type GeocodingRunResult,
  type ReadHold,
} from "./delivery-geocoding-service";

/**
 * The geocoding as the process runs it: the minute's job
 * (jobs/cron/geocode-deliveries-job.ts) and the lookup after a commit
 * (geocode-soon.ts) build the same service on the same pieces — the real
 * repository, the provider of REVERSE_GEOCODER_*, the budget and the gate
 * on ONE Redis connection per process, opened on first use (never when the
 * lookup is off) and closed by the shutdown (shutdownDeliveryGeocoding).
 */
const log = logger.child({ component: "geocoding" });

let redis: Redis | null = null;

function geocodingRedis(): Redis {
  if (redis) return redis;

  redis = new Redis(env.REDIS_URL, redisClientOptions("geocoding-budget"));
  attachRedisConnectionLog(redis, "geocoding-budget");

  return redis;
}

/**
 * The account's pause and today's count, only for a run that asked
 * nothing: the log's transition line says why. The pause and the previous
 * image's count in one MGET, the day's row beside it (F2-32): the count is
 * the greater, as the budget reads it. Redis unreadable, null — the line
 * waits for a run that can tell; the row unreadable, the key's count.
 */
function redisReadHold(
  client: Pick<Redis, "mget">,
  quota?: Pick<IProviderQuotaRepository, "used">,
): ReadHold {
  return async (now) => {
    try {
      const [pause, used] = await client.mget(
        GEOCODING_KEYS.pause,
        GEOCODING_KEYS.budget(now),
      );
      const reason = pauseReasonOf(pause);
      const row = quota
        ? await quota
            .used(GEOCODER_PROVIDER, quotaDay(now), [GEOCODING_SCOPES.job])
            .then((counts) => counts[GEOCODING_SCOPES.job] ?? 0)
            .catch(() => 0)
        : 0;

      return {
        pause: reason
          ? {
              reason,
              until: pauseDeadlineOf(pause),
              status: pauseStatusOf(pause),
            }
          : null,
        used: Math.max(countOf(used), row),
      };
    } catch {
      return null;
    }
  };
}

function deliveryGeocodingService(): DeliveryGeocodingService {
  const config = proofLocationConfigFromEnv().geocoder;
  const client = geocodingRedis();
  const repository = new DeliveryGeocodingRepository();
  const quota = new ProviderQuotaRepository();
  const rates = geocodingRatesFromEnv();

  return new DeliveryGeocodingService({
    repository,
    geocode: (address, query) =>
      geocodeAddress(address, config, undefined, query),
    // The day in Postgres (F2-32), and the previous image's Redis key kept
    // in step while it may still serve (F2-36 drops it).
    budget: createGeocodingBudget({
      quota,
      scope: GEOCODING_SCOPES.job,
      limit: () => env.DELIVERY_GEOCODING_DAILY_BUDGET,
      legacy: {
        redis: client,
        key: GEOCODING_KEYS.budget,
        onError: (err) =>
          log.debug({ err }, "geocoding budget's Redis copy unreadable"),
      },
      onError: (err) =>
        log.warn(
          { err },
          "geocoding budget unreadable: lookups put off to the next run",
        ),
    }),
    // The background paths' ceiling of the minute: the search's tail is
    // left to it (search-address-runtime.ts).
    gate: createRedisGeocodingGate(client, {
      perSecond: rates.perSecond,
      perMinute: rates.backgroundPerMinute,
      onError: (err) =>
        log.warn(
          { err },
          "geocoding gate unreadable: lookups put off to the next run",
        ),
    }),
    announce: (settled) => announceSettledLookups(repository, settled),
    readHold: redisReadHold(client, quota),
    options: {
      batchSize: env.DELIVERY_GEOCODING_BATCH_SIZE,
      spacingMs: spacingFor(rates.perSecond),
      runBudgetMs: env.DELIVERY_GEOCODING_RUN_BUDGET_MS,
      verdictReuseDays: env.GEOCODING_VERDICT_REUSE_DAYS,
    },
    stopping: isDraining,
  });
}

interface RunLog {
  info(details: Record<string, unknown>, message: string): void;
  warn(details: Record<string, unknown>, message: string): void;
  error(details: Record<string, unknown>, message: string): void;
}

/** A state the lookups are held in, and the line that says so. */
interface HeldState {
  key: string;
  details: Record<string, unknown>;
  message: string;
}

/**
 * What holds the lookups after this run: a state; null when they run (or
 * have nothing to do); undefined when the run says nothing new — a burst's
 * minute, a pause that could not be read, a budget spent mid-run (the next
 * run, held, tells).
 */
function heldStateOf(
  result: GeocodingRunResult,
  dailyBudget: number,
  now: Date,
): HeldState | null | undefined {
  const pause = result.hold?.pause ?? null;

  if (pause && (result.skipped === "PAUSED" || result.stoppedBy)) {
    const until = pause.until?.toISOString() ?? null;
    const status = pause.status ?? "?";

    if (pause.reason === "REFUSED") {
      return {
        key: `REFUSED ${status}`,
        details: {
          pauseReason: pause.reason,
          until,
          refusedStatus: pause.status,
        },
        message: `geocoding held: provider refused (HTTP ${status}) until ${until}; check REVERSE_GEOCODER_URL and REVERSE_GEOCODER_KEY`,
      };
    }

    if (pause.reason === "QUOTA") {
      return {
        key: "QUOTA",
        details: { pauseReason: pause.reason, until },
        message: `geocoding held: provider daily quota until ${until}`,
      };
    }

    // A burst holds for a minute: the next run asks again.
    return undefined;
  }

  if (result.skipped === "PAUSED") return undefined;

  if (result.skipped === "BUDGET") {
    const used = result.hold?.used ?? dailyBudget;

    return {
      key: "BUDGET",
      details: {
        todayUsed: used,
        dailyBudget,
        until: nextUtcMidnight(now).toISOString(),
      },
      message: `geocoding held: budget spent for today (${used}/${dailyBudget}); see DELIVERY_GEOCODING_DAILY_BUDGET`,
    };
  }

  if (result.stoppedBy === "BUDGET") return undefined;

  return null;
}

/**
 * The lines of the runs: one per run that did something, the reason when
 * it stopped short, and one per change of what holds the lookups.
 *
 * The HTTP statuses are the diagnosis: 401/403 a key, 404 a URL, 429 the
 * quota, null a provider that did not answer.
 *
 * A held run used to log at debug, which LOG_LEVEL=info (staging and
 * production) never shows: a staging whose lookups the provider refused
 * said nothing between two refusals 15 min apart, and a spent budget said
 * nothing at all (owner's report of 14/11/2026). Now each change of state —
 * refused (with the HTTP and the deadline), the provider's daily quota,
 * today's budget spent (N/M), running again — is one info line per
 * process, the last state kept in memory: a minute held like the one
 * before says nothing.
 */
function createGeocodingRunLog(
  runLog: RunLog,
  dailyBudget: () => number,
  clock: () => Date = () => new Date(),
): (source: "job" | "soon", result: GeocodingRunResult) => void {
  let current: string | null = null;

  return (source, result) => {
    const state = heldStateOf(result, dailyBudget(), clock());
    const key = state?.key ?? null;

    if (state !== undefined && key !== current) {
      const previous = current;

      current = key;

      if (state) {
        runLog.info({ source, ...state.details }, state.message);
      } else {
        runLog.info(
          { source, previous },
          "geocoding running again: lookups no longer held",
        );
      }
    }

    summarize(runLog, source, result);
  };
}

function summarize(
  runLog: RunLog,
  source: "job" | "soon",
  result: GeocodingRunResult,
): void {
  if (result.claimed === 0) return;

  const summary = {
    source,
    claimed: result.claimed,
    resolved: result.resolved,
    coarse: result.coarse,
    notFound: result.notFound,
    failed: result.failed,
    reused: result.reused,
    reusedVerdicts: result.reusedVerdicts,
    released: result.released,
    stoppedBy: result.stoppedBy ?? null,
    providerStatuses: result.providerStatuses,
  };

  if (result.stoppedBy === "REFUSED") {
    runLog.error(
      summary,
      "geocoding provider refused the request: check REVERSE_GEOCODER_URL and REVERSE_GEOCODER_KEY; lookups paused for 15 min",
    );
  } else if (result.stoppedBy === "RATE_LIMITED") {
    runLog.warn(summary, "geocoding provider rate-limited the lookups");
  } else if (result.stoppedBy === "FAILURES") {
    runLog.warn(summary, "geocoding provider failing: run stopped early");
  } else {
    runLog.info(summary, "delivery addresses geocoded");
  }
}

/** The process's: the job and the lookups after a commit share it. */
const logGeocodingRun = createGeocodingRunLog(
  log,
  () => env.DELIVERY_GEOCODING_DAILY_BUDGET,
);

/**
 * Closes the process's connection; the next use opens another.
 *
 * `deadlineMs` is what is left of the shutdown's workers step
 * (workers/index.ts). A QUIT that Redis does not answer in it — or refuses —
 * drops the connection instead: the step must end before the watchdog,
 * and a budget or pause key not written is the job's to redo. Without it,
 * the QUIT is awaited.
 */
async function closeGeocodingRedis(
  options: { deadlineMs?: number } = {},
): Promise<void> {
  const client = redis;

  redis = null;

  if (!client) return;

  let refused = false;
  const quitting = client.quit().catch(() => {
    refused = true;
  });

  const answered = await settlesWithin(
    quitting,
    options.deadlineMs ?? Infinity,
  );

  if (!answered || refused) client.disconnect();
}

export {
  closeGeocodingRedis,
  createGeocodingRunLog,
  deliveryGeocodingService,
  geocodingRedis,
  logGeocodingRun,
  redisReadHold,
};
