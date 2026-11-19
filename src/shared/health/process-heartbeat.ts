import database from "@/../infra/database";
import { RedisConnection } from "@/../infra/cache/redis-connection";
import { env } from "@/env";
import { buildInfo } from "@/shared/build-info";
import {
  configFingerprint,
  readDatabaseIdentity,
  redisRunIdFrom,
} from "@/shared/health/config-fingerprint";
import { opsSampleIdentity } from "@/shared/health/ops-sample";
import type { WorkerQueue } from "@/shared/lifecycle/process-role";
import { logger } from "@/shared/logging/logger";
import { pubsubServerInfo } from "@/shared/redis/pubsub-redis";
import { swarmIdentity } from "@/shared/swarm-identity";

const log = logger.child({ component: "process-heartbeat" });

/**
 * Every live process, in one table (plano-escala F3-03).
 *
 * With the roles of wave 12 the same image runs as several Applications, and
 * nothing said which processes exist: which queues have a consumer, which
 * process runs the cron, whether every one is on the new commit, whether
 * one of them was started with another environment's settings. Each
 * process — every role, the HTTP-only ones included — keeps one row in
 * process_heartbeat:
 *
 *  - UPSERTed now and then every 30 s ± 5 s (the jitter keeps the replicas
 *    of one deploy from writing in the same second), stamped with the
 *    database's now(), so a skewed container clock never ages a row;
 *  - deleted on SIGTERM: a process going away stops counting as a
 *    consumer at once, not 90 s later;
 *  - fail-open: a write that fails is a warning, once per outage, and the
 *    process keeps serving; a write still in flight makes the next beat
 *    skip instead of piling up;
 *  - a row whose process died without its SIGTERM ages out of the live
 *    window (90 s) and is purged after 7 days (purge-ops-series).
 *
 * The configuration's fingerprint is computed again on every beat, because
 * its identities can change under a running process (the Redis restarts
 * with a new run_id; a restore gives the database a new cluster): all the
 * processes converge on the new one within a beat. Until both identities
 * were read once, it is null, which the checks read as "not yet known".
 */

/** Between two beats, before the jitter. */
const BEAT_INTERVAL_MS = 30_000;

/** Each beat lands up to this much before or after the interval. */
const BEAT_JITTER_MS = 5_000;

/** A row older than this is a process that stopped beating. */
const LIVE_WINDOW_SECONDS = 90;

/** How long the live consumers are reused before being read again. */
const LIVE_CONSUMERS_CACHE_MS = 30_000;

/** The INFO call and the DELETE on the way out never wait longer. */
const SIDE_CALL_DEADLINE_MS = 2_000;

/** Days a row without a beat is kept before the purge. */
const PROCESS_HEARTBEAT_RETENTION_DAYS = 7;

interface ProcessHeartbeatRow {
  replica: string;
  role: string;
  app_env: string;
  build_commit: string | null;
  config_fingerprint: string | null;
  node_hostname: string | null;
  queues: readonly WorkerQueue[];
  cron: boolean;
  sockets: boolean;
  started_at: Date;
}

/** One UPSERT, stamped with the database's own clock. */
async function writeProcessHeartbeat(row: ProcessHeartbeatRow): Promise<void> {
  await database.$executeRaw`
    INSERT INTO "process_heartbeat" (
      "replica", "role", "app_env", "build_commit", "config_fingerprint",
      "node_hostname", "queues", "cron", "sockets", "started_at", "updated_at"
    ) VALUES (
      ${row.replica}, ${row.role}, ${row.app_env}, ${row.build_commit},
      ${row.config_fingerprint}, ${row.node_hostname},
      ${[...row.queues]}::text[], ${row.cron}, ${row.sockets},
      ${row.started_at}, now()
    )
    ON CONFLICT ("replica") DO UPDATE SET
      "role" = EXCLUDED."role",
      "app_env" = EXCLUDED."app_env",
      "build_commit" = EXCLUDED."build_commit",
      "config_fingerprint" = EXCLUDED."config_fingerprint",
      "node_hostname" = EXCLUDED."node_hostname",
      "queues" = EXCLUDED."queues",
      "cron" = EXCLUDED."cron",
      "sockets" = EXCLUDED."sockets",
      "started_at" = EXCLUDED."started_at",
      "updated_at" = now()
  `;
}

async function deleteProcessHeartbeat(replica: string): Promise<void> {
  await database.$executeRaw`
    DELETE FROM "process_heartbeat" WHERE "replica" = ${replica}
  `;
}

/** Resolves with the promise, or rejects after `ms`; never hangs. */
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("deadline")), ms);
      timer.unref();
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * The fingerprint's identities, the last ones read standing in while a
 * server does not answer: a Redis restarting must not flip the fingerprint
 * of the processes that happened to beat during it.
 */
function createFingerprintReader(deps: {
  databaseIdentity: () => Promise<string>;
  redisInfo: () => Promise<string>;

  /**
   * The pub/sub's Redis, when it is not the counters' one
   * (pubsubServerInfo); null names the counters' server for both.
   */
  pubsubInfo?: (() => Promise<string>) | null;
}) {
  let database: string | null = null;
  let redis: string | null = null;
  let pubsub: string | null = null;

  const runIdOf = async (
    info: () => Promise<string>,
    last: string | null,
  ): Promise<string | null> => {
    try {
      return (
        redisRunIdFrom(await withDeadline(info(), SIDE_CALL_DEADLINE_MS)) ??
        last
      );
    } catch {
      // The last one read stands; null before the first.
      return last;
    }
  };

  return async (): Promise<string | null> => {
    try {
      database = await deps.databaseIdentity();
    } catch {
      // The last one read stands; null before the first.
    }

    redis = await runIdOf(deps.redisInfo, redis);
    pubsub = deps.pubsubInfo ? await runIdOf(deps.pubsubInfo, pubsub) : redis;

    if (database === null || redis === null || pubsub === null) return null;

    return configFingerprint(env, { database, redis, pubsub });
  };
}

interface ProcessHeartbeatDeps {
  /** The row, without the fingerprint; read on every beat. */
  row: () => Omit<ProcessHeartbeatRow, "config_fingerprint">;
  fingerprint: () => Promise<string | null>;
  write: (row: ProcessHeartbeatRow) => Promise<void>;
  remove: (replica: string) => Promise<void>;
  intervalMs?: number;
  jitterMs?: number;
  random?: () => number;
}

interface ProcessHeartbeat {
  /** Stops the beats and deletes the row; never throws, never hangs. */
  stop: () => Promise<void>;
}

function startProcessHeartbeat(deps: ProcessHeartbeatDeps): ProcessHeartbeat {
  const intervalMs = deps.intervalMs ?? BEAT_INTERVAL_MS;
  const jitterMs = deps.jitterMs ?? BEAT_JITTER_MS;
  const random = deps.random ?? Math.random;

  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> | null = null;
  let stopped = false;
  let failing = false;

  const beat = (): void => {
    if (stopped || inFlight) return;

    inFlight = (async () => {
      try {
        const row = deps.row();

        await deps.write({
          ...row,
          config_fingerprint: await deps.fingerprint(),
        });

        if (failing) {
          failing = false;
          log.info("process heartbeat written again");
        }
      } catch (error) {
        // Once per outage: the next beat tries again.
        if (!failing) {
          failing = true;
          log.warn({ err: error }, "process heartbeat could not be written");
        }
      } finally {
        inFlight = null;
      }
    })();
  };

  const schedule = (): void => {
    if (stopped) return;

    const delay = intervalMs + Math.round((random() * 2 - 1) * jitterMs);

    timer = setTimeout(() => {
      beat();
      schedule();
    }, delay);

    // Never what keeps a stopping process alive.
    timer.unref();
  };

  // The first beat now: a deploy's check sees the process within a second
  // of its boot, not half a minute later.
  beat();
  schedule();

  return {
    stop: async () => {
      if (stopped) return;

      stopped = true;

      if (timer) clearTimeout(timer);
      timer = null;

      try {
        // A beat still writing would re-create the row after the DELETE.
        if (inFlight) {
          await withDeadline(inFlight, SIDE_CALL_DEADLINE_MS).catch(
            () => undefined,
          );
        }

        await withDeadline(
          deps.remove(deps.row().replica),
          SIDE_CALL_DEADLINE_MS,
        );
      } catch (error) {
        // The row ages out of the live window on its own.
        log.warn({ err: error }, "process heartbeat could not be deleted");
      }
    },
  };
}

/** This process's row, as the env resolved its role (F3-01, F3-02). */
function currentProcessRow(
  startedAt: Date,
): Omit<ProcessHeartbeatRow, "config_fingerprint"> {
  return {
    replica: opsSampleIdentity(env.PROCESS_ROLE).replica,
    role: env.PROCESS_ROLE,
    app_env: env.APP_ENV,
    build_commit: buildInfo.commit,
    node_hostname: swarmIdentity.node ?? null,
    queues: env.WORKER_QUEUES,
    cron: env.CRON_ENABLED,
    sockets: env.SOCKETS_ENABLED,
    started_at: startedAt,
  };
}

/** The heartbeat of this process, on the runtime's own clients. */
function startRuntimeProcessHeartbeat(): ProcessHeartbeat {
  const startedAt = new Date();

  return startProcessHeartbeat({
    row: () => currentProcessRow(startedAt),
    fingerprint: createFingerprintReader({
      databaseIdentity: () => readDatabaseIdentity(database),
      redisInfo: async () =>
        (await RedisConnection.getInstance().getClient()).info("server"),
      pubsubInfo: pubsubServerInfo(),
    }),
    write: writeProcessHeartbeat,
    remove: deleteProcessHeartbeat,
  });
}

/** How many live processes claim each queue. */
async function readLiveConsumers(): Promise<Map<string, number>> {
  const rows = await database.$queryRaw<
    Array<{ queue: string; consumers: number }>
  >`
    SELECT q AS queue, count(*)::int AS consumers
    FROM "process_heartbeat", unnest("queues") AS q
    WHERE "updated_at" > now() - make_interval(secs => ${LIVE_WINDOW_SECONDS})
    GROUP BY q
  `;

  return new Map(rows.map((row) => [row.queue, row.consumers]));
}

/**
 * How many live processes of this environment hold sockets: what the
 * chat's presence compares with the adapter's servers to find a replica
 * that does not beat (shared/socket/presence.ts, createLegacyPeerCheck).
 */
async function readLiveSocketProcesses(): Promise<number> {
  const [row] = await database.$queryRaw<Array<{ processes: number }>>`
    SELECT count(*)::int AS processes
    FROM "process_heartbeat"
    WHERE "sockets"
      AND "app_env" = ${env.APP_ENV}
      AND "updated_at" > now() - make_interval(secs => ${LIVE_WINDOW_SECONDS})
  `;

  return row?.processes ?? 0;
}

/**
 * The live consumers of each queue, read at most once every 30 s per
 * process. A read that fails keeps the last answer; with none yet, the
 * count is null ("unknown"), and a caller decides what unknown means.
 */
function createLiveConsumers(
  read: () => Promise<Map<string, number>> = readLiveConsumers,
  now: () => number = Date.now,
) {
  let cache: { at: number; counts: Map<string, number> } | null = null;
  let reading: Promise<void> | null = null;

  const refresh = async (): Promise<void> => {
    try {
      cache = { at: now(), counts: await read() };
    } catch {
      // The last answer stands, aged as it is.
    }
  };

  return async (queue: WorkerQueue): Promise<number | null> => {
    if (!cache || now() - cache.at >= LIVE_CONSUMERS_CACHE_MS) {
      reading ??= refresh().finally(() => {
        reading = null;
      });

      await reading;
    }

    return cache ? (cache.counts.get(queue) ?? 0) : null;
  };
}

/** This process's reader of the live consumers (F3-04's wake asks it). */
const liveConsumers = createLiveConsumers();

export {
  BEAT_INTERVAL_MS,
  BEAT_JITTER_MS,
  LIVE_CONSUMERS_CACHE_MS,
  LIVE_WINDOW_SECONDS,
  PROCESS_HEARTBEAT_RETENTION_DAYS,
  createFingerprintReader,
  createLiveConsumers,
  currentProcessRow,
  deleteProcessHeartbeat,
  liveConsumers,
  readLiveConsumers,
  readLiveSocketProcesses,
  startProcessHeartbeat,
  startRuntimeProcessHeartbeat,
  writeProcessHeartbeat,
};
export type { ProcessHeartbeat, ProcessHeartbeatDeps, ProcessHeartbeatRow };
