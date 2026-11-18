import { databaseBatch } from "@/../infra/database";
import { CronJobDefinition } from "@/shared/services/cron-scheduler-service";

import { env } from "@/env";
import {
  alertThresholdsFromEnv,
  evaluateAlerts,
  type OperationalSnapshot,
} from "@/shared/health/alert-rules";
import {
  readClusterReadings,
  recordClusterSample,
  withClusterReadings,
  type ClusterReadings,
} from "@/shared/health/cluster-sample";
import { collectDatabaseMetrics } from "@/shared/health/database-metrics";
import { sendHeartbeat } from "@/shared/health/heartbeat-client";
import { collectOperationalSnapshot } from "@/shared/health/operational-snapshot";

/**
 * The dead man's switch (OBS-03).
 *
 * Every minute, one replica — the cron election's unique (jobName,
 * scheduledFor) row, so exactly one ping per minute cluster-wide — reads the
 * operational snapshot, applies the alert rules and pushes the verdict to the
 * external check (HEALTHCHECK_PING_URL). Unset, the reasons still go to the
 * log and nothing is called: development and tests run without it.
 *
 * What pages, and how:
 *  - a queue whose due items are not being taken (outbox, both delivery
 *    lanes, webhooks, AI), a credential the provider refuses, a burst of
 *    terminal failures, a cron job with no success in 26 h, the position
 *    partitions running out, a stuck worker, connections near the ceiling,
 *    Redis gone → /fail with the reasons;
 *  - and the database's own numbers and Redis' memory (plano-escala F1-11):
 *    archiving stopped, failing, or off with PITR_EXPECTED=true, the xid
 *    past a billion, a write open past LONG_WRITE_XACT_ALERT_SECONDS,
 *    pg_wal past PG_WAL_ALERT_GIB, Redis evicting keys, or without a
 *    ceiling / with noeviction → /fail too;
 *  - the fleet of process_heartbeat (plano-escala F3-34): a queue with a
 *    row due for two minutes and no live consumer in this environment, the
 *    processes on different commits for half an hour, and a process of
 *    another APP_ENV writing to this database → /fail. The rows' APP_ENV is
 *    compared with this process's own (the snapshot carries it);
 *  - the database, the scheduler or every replica gone → no ping at all.
 *    That includes a split fleet whose only cron process (the worker) is
 *    down: the api runs no cron, so the silence is what pages.
 *
 * The cluster readings (the database's numbers, Redis, the eviction
 * baseline) are read once, before the ping, because the rules judge them.
 * After the ping, the same winner writes the cluster's row of the
 * per-minute series (ops_sample, role 'cluster', plano-escala F1-10) from
 * those readings and the queues of this snapshot, stamped with the elected
 * minute, so the cluster has one row a minute however many replicas fire.
 * A failure there is a warning: the ping already went.
 *
 * Quiet: two info lines a minute from the scheduler would drown the log.
 * scheduled_job_execution keeps two days of its rows (see
 * cleanup-notification-pipeline-job), not thirty.
 */
const OPS_HEARTBEAT_JOB = "ops-heartbeat";

/**
 * The verdict of one minute: the snapshot and the cluster readings, judged
 * with the limits the environment sets (PITR_EXPECTED,
 * LONG_WRITE_XACT_ALERT_SECONDS, PG_WAL_ALERT_GIB).
 */
function heartbeatReasons(
  snapshot: OperationalSnapshot,
  readings: ClusterReadings,
): string[] {
  return evaluateAlerts(
    withClusterReadings(snapshot, readings),
    alertThresholdsFromEnv(env),
    { pitrExpected: env.PITR_EXPECTED },
  );
}

const opsHeartbeatJob: CronJobDefinition = {
  name: OPS_HEARTBEAT_JOB,
  schedule: "* * * * *",
  quiet: true,
  handler: async (run) => {
    // The cluster-wide checks of the snapshot (the feed's txid, the
    // cluster's epoch) on the maintenance pool too.
    const snapshot = await collectOperationalSnapshot(
      new Date(),
      databaseBatch,
    );

    // Called directly (a test), the run has no slot: this minute stands in.
    const slot = run?.scheduledFor ?? new Date(snapshot.now);
    if (!run) slot.setUTCSeconds(0, 0);

    // The database's numbers on the maintenance pool (F3-18): after the
    // cut of the database roles only trajetto_batch sees the other
    // sessions and pg_wal. The election stays on the app's pool.
    const readings = await readClusterReadings(slot, {
      readDatabase: (withSizes) =>
        collectDatabaseMetrics({
          client: databaseBatch,
          sizes: withSizes ? "fresh" : "skip",
        }),
    });

    await sendHeartbeat(heartbeatReasons(snapshot, readings));

    await recordClusterSample(slot, snapshot, readings);
  },
};

export { OPS_HEARTBEAT_JOB, heartbeatReasons, opsHeartbeatJob };
