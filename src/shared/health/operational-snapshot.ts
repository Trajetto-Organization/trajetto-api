import { Prisma } from "@prisma/client";
import { container } from "tsyringe";

import database from "@/../infra/database";
import { RedisConnection } from "@/../infra/cache/redis-connection";
import { env } from "@/env";
import { GEOCODER_PROVIDER } from "@/shared/delivery/geocoding/geocoding-budget";
import { quotaDay } from "@/shared/services/provider-quota/provider-quota-repository";

import { readWebhookQueueMetrics } from "@/shared/integration/webhook-metrics";
import {
  DELIVERY_LANES,
  type DeliveryLane,
} from "@/shared/notifications/pipeline-rules";
import { CronSchedulerService } from "@/shared/services/cron-scheduler-service";

import { PROVIDER_PAUSED_MARKER } from "@/shared/ai/provider-failure";

// Side effect: registers "ProofSigningService" (@registry).
import "@/shared/services/proof-signing/proof-signing-service";
import type { ProofSigningService } from "@/shared/services/proof-signing/proof-signing-service";
import type { OperationalSnapshot } from "./alert-rules";
import { readClusterEpochState } from "./cluster-epoch";
import { readFeedTxidState } from "./feed-txid";
import { connectionUsagePercent } from "./metrics-math";
import { deliveryBacklogSql } from "./metrics-queries";
import {
  readCronJobs,
  legacyRunway,
  readPartitionStates,
  readWorkerHeartbeats,
} from "./operational-state";

/**
 * What the ops heartbeat reads every minute (OBS-03).
 *
 * A dozen small reads, each on an index that exists for it — the same ones
 * /health/metrics uses (metrics-queries.ts, operational-state.ts). One after
 * the other, on purpose: this runs once a minute on one replica and must
 * never take more than one slot of the pool it is watching.
 *
 * Each part is read on its own: a part that fails is reported as a reason
 * (collectionErrors) and the rest is still judged. When the DATABASE is what
 * failed, the cron election itself fails first and no ping is sent at all —
 * which is exactly the silence the external check pages on.
 */

/** How far back a terminal failure still counts; a few runs of overlap. */
const FAILURE_WINDOW_MS = 10 * 60 * 1000;

/** The rules only need the newest failures of each kind. */
const FAILURE_SAMPLE = 200;

const REDIS_TIMEOUT_MS = 2_000;

/**
 * The AI reader's refusal of our token: LocalOcrHttpError messages start with
 * the status ("401 unauthorized: …"). The older alternatives match
 * Anthropic-era rows still in the 180-day window.
 */
const AI_CREDENTIAL_PATTERN =
  "(authentication_error|permission_error|invalid x-api-key|^40[13][^0-9])";

/**
 * How long before its failure a request may have become due. A request that
 * gave up inside the window was last due no earlier than this, unless the AI
 * queue was a day behind — which the AI lag rule reports on its own.
 */
const AI_DUE_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/**
 * AI requests that gave up since `since` on a refused key.
 *
 * The only index that reads this table by status is (status, availableAt).
 * With no range on availableAt the check walked every FAILED and PARTIAL
 * request of the 180 days kept, and fetched each row to test updated_at —
 * once a minute. The availableAt bound makes it a range of that index
 * (tests/E2E/ops-heartbeat-plans.test.ts).
 */
function aiCredentialFailuresSql(since: Date): Prisma.Sql {
  return Prisma.sql`
    SELECT count(*)::int AS n
    FROM "ai_analysis_request"
    WHERE "status" IN ('FAILED', 'PARTIAL')
      AND "availableAt" >= ${new Date(since.getTime() - AI_DUE_LOOKBACK_MS)}
      AND "updated_at" >= ${since}
      AND "lastError" ~* ${AI_CREDENTIAL_PATTERN}
  `;
}

async function part<T>(
  name: string,
  errors: string[],
  read: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    errors.push(
      `${name}: ${error instanceof Error ? error.message : String(error)}`,
    );

    return fallback;
  }
}

/** The client of the cluster-wide checks (F2-03, U-14); see below. */
type MaintenanceClient = Pick<Prisma.TransactionClient, "$queryRaw">;

/**
 * `maintenance` runs the cluster-wide checks (the feed's txid, the
 * cluster's epoch): the ops heartbeat passes the maintenance pool,
 * databaseBatch, which only the crons may import
 * (tests/unitaires/database/database-read-guard.test.ts); a test calling
 * this directly reads them on the app's pool.
 */
async function collectOperationalSnapshot(
  now: Date = new Date(),
  maintenance: MaintenanceClient = database,
): Promise<OperationalSnapshot> {
  const errors: string[] = [];
  const since = new Date(now.getTime() - FAILURE_WINDOW_MS);

  const outboxEligibleLagSec = await part(
    "outbox",
    errors,
    async () => {
      const [row] = await database.$queryRaw<Array<{ lag: number | null }>>`
        SELECT EXTRACT(EPOCH FROM (now() - MIN("availableAt")))::float AS lag
        FROM "domain_outbox_event"
        WHERE "status" = 'PENDING' AND "availableAt" <= now()
      `;

      return row?.lag ?? null;
    },
    null,
  );

  const deliveryEligibleLagSec: OperationalSnapshot["deliveryEligibleLagSec"] =
    {
      internal: null,
      external: null,
    };

  for (const lane of Object.keys(DELIVERY_LANES) as DeliveryLane[]) {
    deliveryEligibleLagSec[lane] = await part(
      `notification_delivery (${lane})`,
      errors,
      async () => {
        const rows = await database.$queryRaw<
          Array<{ oldest_eligible_seconds: number | null }>
        >(deliveryBacklogSql(lane));

        const lags = rows
          .map((row) => row.oldest_eligible_seconds)
          .filter((lag): lag is number => lag !== null);

        return lags.length > 0 ? Math.max(...lags) : null;
      },
      null,
    );
  }

  const webhookDueLagSec = await part(
    "webhook_delivery",
    errors,
    async () => (await readWebhookQueueMetrics()).oldest_due_seconds,
    null,
  );

  const aiEligibleLagSec = await part(
    "ai_analysis_request",
    errors,
    async () => {
      const [row] = await database.$queryRaw<Array<{ lag: number | null }>>`
        SELECT EXTRACT(EPOCH FROM (now() - MIN("availableAt")))::float AS lag
        FROM "ai_analysis_request"
        WHERE "status" = 'PENDING' AND "availableAt" <= now()
      `;

      return row?.lag ?? null;
    },
    null,
  );

  // Newest first, on the partial notification_delivery_failed_idx
  // ("updated_at", "channel") WHERE status = 'FAILED': a range on its
  // leading column that stops at the sample.
  const deliveryFailures = await part(
    "notification_delivery (falhas)",
    errors,
    () =>
      database.$queryRaw<Array<{ channel: string; lastError: string | null }>>`
        SELECT "channel"::text AS channel, "lastError"
        FROM "notification_delivery"
        WHERE "status" = 'FAILED' AND "updated_at" >= ${since}
        ORDER BY "updated_at" DESC
        LIMIT ${FAILURE_SAMPLE}
      `,
    [],
  );

  // Due requests put back by a provider that refused service to everybody
  // (spend or usage limit, AI-8): the pipeline stopped claiming, so they wait
  // without failing. Same (status, availableAt) range as the lag above.
  const aiProviderPausedRequests = await part(
    "ai_analysis_request (pausa do provedor)",
    errors,
    async () => {
      const [row] = await database.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n
        FROM "ai_analysis_request"
        WHERE "status" = 'PENDING'
          AND "availableAt" <= now()
          AND starts_with("lastError", ${PROVIDER_PAUSED_MARKER})
      `;

      return row?.n ?? 0;
    },
    0,
  );

  const aiCredentialFailures = await part(
    "ai_analysis_request (falhas)",
    errors,
    async () => {
      const [row] = await database.$queryRaw<Array<{ n: number }>>(
        aiCredentialFailuresSql(since),
      );

      return row?.n ?? 0;
    },
    0,
  );

  // Only the jobs this build schedules: a job removed or renamed keeps its
  // old rows for 30 days and must not page for being "late" all that time.
  const cronJobs = await part(
    "scheduled_job_execution",
    errors,
    async () =>
      (await readCronJobs(CronSchedulerService.getInstance().registeredJobs()))
        .filter((job) => job.schedule !== null)
        .map((job) => ({
          job: job.job,
          lastStatus: job.last_status,
          lastSucceededAt: job.last_succeeded_at
            ? new Date(job.last_succeeded_at)
            : null,
          staleRunning: job.stale_running,
          lastPartial: job.last_partial,
          partialSince: job.partial_since ? new Date(job.partial_since) : null,
        })),
    [],
  );

  // Every registered table's partitions (F2-09): the runway of each, the
  // earlier lookahead warning, and partitions past the retention that were
  // never dropped.
  const partitionStates = await part(
    "partições",
    errors,
    () => readPartitionStates(now),
    null,
  );
  const runway = partitionStates
    ? legacyRunway(partitionStates.driver_position)
    : null;

  // Replicas gone for more than a few minutes are already left out by the
  // reader, so a deploy that replaced every replica pages nobody.
  const stuckWorkers = await part(
    "worker_heartbeat",
    errors,
    async () =>
      (await readWorkerHeartbeats(now))
        .filter((worker) => worker.stuck)
        .map(({ replica, worker }) => ({ replica, worker })),
    [],
  );

  const usage = await part(
    "pg_stat_activity",
    errors,
    async () => {
      const [row] = await database.$queryRaw<
        Array<{ active: bigint; max: string }>
      >`
        SELECT
          (SELECT count(*) FROM pg_stat_activity
            WHERE datname = current_database()) AS active,
          current_setting('max_connections') AS max
      `;

      return connectionUsagePercent(
        Number(row?.active ?? 0),
        Number(row?.max ?? 0),
      );
    },
    0,
  );

  const redisOk = await pingRedis();

  // The proof signing certificate (design §7.4): read from the process's own
  // service, so an unreadable PFX here is the same state the proofs see.
  const proofSigning = await part(
    "proof_signing",
    errors,
    async () => {
      const health = container
        .resolve<ProofSigningService>("ProofSigningService")
        .health(now);

      return {
        state: health.state,
        reason: health.reason,
        notAfter: health.not_after ? new Date(health.not_after) : null,
      };
    },
    undefined,
  );

  // The geocoder's day against the plan (F2-32), only with a quota written
  // down. The account's scopes only: a scope with a colon is a company's
  // share of the one before it, already in its count.
  const dailyQuota = env.LOCATIONIQ_DAILY_QUOTA;
  const geocodingQuota =
    dailyQuota !== undefined
      ? await part(
          "provider_quota_day",
          errors,
          async () => {
            const [row] = await database.$queryRaw<Array<{ used: number }>>`
              SELECT COALESCE(SUM("used"), 0)::int AS "used"
              FROM "provider_quota_day"
              WHERE "provider" = ${GEOCODER_PROVIDER}
                AND "day" = ${quotaDay(now)}::date
                AND strpos("scope", ':') = 0
            `;

            return { usedToday: Number(row?.used ?? 0), dailyQuota };
          },
          undefined,
        )
      : undefined;

  // The feed's stamp against the cluster (F2-03): one probe per tenant down
  // the feed's index, on the maintenance client (the heartbeat passes
  // databaseBatch).
  const feedTxid = await part(
    "delivery_event (txid)",
    errors,
    () => readFeedTxidState(maintenance),
    null,
  );

  // The cluster's epoch against the cluster (U-14): one row and two
  // pg_control functions, on the same client.
  const clusterEpoch = await part(
    "cluster_epoch",
    errors,
    () => readClusterEpochState(maintenance),
    null,
  );

  return {
    now,
    outboxEligibleLagSec,
    deliveryEligibleLagSec,
    webhookDueLagSec,
    aiEligibleLagSec,
    deliveryFailures,
    aiCredentialFailures,
    aiProviderPausedRequests,
    cronJobs,
    // Unreadable is not "fine": the collection error already says so, and
    // a runway that cannot be read is not reported twice.
    partitionRunwayOk: runway?.runway_ok ?? true,
    partitionRunwayDays: runway?.partition_runway_days ?? null,
    ...(partitionStates && {
      partitions: Object.entries(partitionStates).map(([table, state]) => ({
        table,
        lookaheadDays: state.lookahead_days,
        runwayOk: state.runway_ok,
        lookaheadOk: state.lookahead_ok,
        stuck: state.stuck,
      })),
    }),
    stuckWorkers,
    connectionUsagePercent: usage,
    redisOk,
    proofSigning,
    ...(geocodingQuota && { geocodingQuota }),
    ...(feedTxid && { feedTxid }),
    ...(clusterEpoch && { clusterEpoch }),
    collectionErrors: errors,
  };
}

async function pingRedis(): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;

  try {
    await Promise.race([
      (async () => {
        const client = await RedisConnection.getInstance().getClient();

        await client.ping();
      })(),
      new Promise((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("timeout")),
          REDIS_TIMEOUT_MS,
        );
        timer.unref();
      }),
    ]);

    return true;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export {
  FAILURE_WINDOW_MS,
  aiCredentialFailuresSql,
  collectOperationalSnapshot,
};
