import Redis from "ioredis";

import { env } from "@/env";
import { redisClientOptions } from "@/config/redis-client-options";
import { logger } from "@/shared/logging/logger";
import { attachRedisConnectionLog } from "@/shared/services/redis-connection-log";
import { proofLocationConfigFromEnv } from "@/shared/services/proof-location/proof-location-service";
import { geocodeAddress } from "@/shared/services/proof-location/address-geocoder";

import { announceSettledLookups } from "./geocoding-announcer";
import { createRedisGeocodingBudget } from "./geocoding-budget";
import {
  createRedisGeocodingGate,
  pauseDeadlineOf,
  pauseReasonOf,
  pauseStatusOf,
} from "./geocoding-gate";
import { GEOCODING_KEYS } from "./geocoding-keys";
import { DeliveryGeocodingRepository } from "./geocoding-repository";
import {
  DeliveryGeocodingService,
  nextUtcMidnight,
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
 * The account's pause and today's count in one MGET, only for a run that
 * asked nothing: the log's transition line says why. Unreadable, null —
 * the line waits for a run that can tell.
 */
function redisReadHold(client: Pick<Redis, "mget">): ReadHold {
  return async (now) => {
    try {
      const [pause, used] = await client.mget(
        GEOCODING_KEYS.pause,
        GEOCODING_KEYS.budget(now),
      );
      const reason = pauseReasonOf(pause);
      const count = Number(used ?? 0);

      return {
        pause: reason
          ? {
              reason,
              until: pauseDeadlineOf(pause),
              status: pauseStatusOf(pause),
            }
          : null,
        used: Number.isFinite(count) ? count : null,
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

  return new DeliveryGeocodingService({
    repository,
    geocode: (address, query) =>
      geocodeAddress(address, config, undefined, query),
    budget: createRedisGeocodingBudget(
      client,
      env.DELIVERY_GEOCODING_DAILY_BUDGET,
      (err) =>
        log.warn(
          { err },
          "geocoding budget unreadable: lookups put off to the next run",
        ),
    ),
    gate: createRedisGeocodingGate(client, {
      onError: (err) =>
        log.warn(
          { err },
          "geocoding gate unreadable: lookups put off to the next run",
        ),
    }),
    announce: (settled) => announceSettledLookups(repository, settled),
    readHold: redisReadHold(client),
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

/** Closes the process's connection; the next use opens another. */
async function closeGeocodingRedis(): Promise<void> {
  const client = redis;

  redis = null;

  try {
    await client?.quit();
  } catch {
    client?.disconnect();
  }
}

export {
  closeGeocodingRedis,
  createGeocodingRunLog,
  deliveryGeocodingService,
  geocodingRedis,
  logGeocodingRun,
  redisReadHold,
};
