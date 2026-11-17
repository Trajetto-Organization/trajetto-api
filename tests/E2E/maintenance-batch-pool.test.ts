import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { databaseBatch } from "@/../infra/database";
import { cleanupApiUsageJob } from "@/jobs/cron/cleanup-api-usage-job";
import { cleanupDeliveryEventSubmissionsJob } from "@/jobs/cron/cleanup-delivery-event-submissions-job";
import { cleanupExpiredRefreshTokensJob } from "@/jobs/cron/cleanup-expired-refresh-tokens-job";
import { cleanupNotificationPipelineJob } from "@/jobs/cron/cleanup-notification-pipeline-job";
import { opsHeartbeatJob } from "@/jobs/cron/ops-heartbeat-job";
import { partitionMaintenanceJob } from "@/jobs/cron/partition-maintenance-job";
import { purgeOpsSeriesJob } from "@/jobs/cron/purge-ops-series-job";
import { createPrismaClient } from "@/shared/database/database-client";
import {
  collectDatabaseMetrics,
  withClusterSample,
} from "@/shared/health/database-metrics";

/**
 * The maintenance runs on databaseBatch (plano-escala F3-18): the nightly
 * purges, the partitions and the database's heavy numbers of the ops
 * heartbeat, while the cron's election stays on the app's pool.
 *
 * Why it matters: a purge holds a connection for its whole five-minute
 * budget, which on the app's pool of ten is one fewer for every request of
 * the replica; and after the cut of the database roles only the batch
 * login (trajetto_batch) has DELETE on delivery_event, the partitions'
 * owner role and pg_read_all_stats. The proof here is direct: with the
 * batch pool pointed at a closed port, each job fails, and the app's pool
 * is untouched; pointed back, each one runs.
 *
 * And the API side: a login that may not read the other sessions nor
 * pg_wal (trajetto_http after the cut; here a NOLOGIN role of this file,
 * through SET LOCAL ROLE) gets those parts on /health/metrics from the
 * cluster row the heartbeat wrote on the batch pool, instead of nulls.
 */
const prisma = createPrismaClient({ log: [] });
const PROBE_ROLE = `wfl_http_probe_${randomBytes(4).toString("hex")}`;

/** A Postgres URL nobody listens on: the closed port of the loopback. */
function closedUrl(): string {
  const url = new URL(process.env.DATABASE_URL as string);

  url.hostname = "127.0.0.1";
  url.port = "1";
  url.searchParams.set("connect_timeout", "2");

  return url.toString();
}

async function onBatchUrl<T>(
  url: string | undefined,
  work: () => Promise<T>,
): Promise<T> {
  // The pool reads its URL when it connects: a disconnect makes the next
  // statement build it again.
  await databaseBatch.$disconnect();

  if (url) process.env.BATCH_DATABASE_URL = url;
  else delete process.env.BATCH_DATABASE_URL;

  try {
    return await work();
  } finally {
    await databaseBatch.$disconnect();
    delete process.env.BATCH_DATABASE_URL;
  }
}

beforeAll(async () => {
  await prisma.$executeRawUnsafe(`CREATE ROLE ${PROBE_ROLE} NOLOGIN`);
});

afterAll(async () => {
  await prisma.$executeRawUnsafe(`DROP ROLE IF EXISTS ${PROBE_ROLE}`);
  await prisma.$disconnect();
  await databaseBatch.$disconnect();
});

describe("the maintenance on the batch pool", () => {
  const jobs = [
    cleanupApiUsageJob,
    cleanupDeliveryEventSubmissionsJob,
    cleanupExpiredRefreshTokensJob,
    cleanupNotificationPipelineJob,
    purgeOpsSeriesJob,
    partitionMaintenanceJob,
  ];

  it.each(jobs.map((job) => [job.name, job] as const))(
    "runs %s on BATCH_DATABASE_URL, never on the app's pool",
    async (_name, job) => {
      await onBatchUrl(closedUrl(), async () => {
        await expect(job.handler()).rejects.toThrow();

        // The app's pool answered all along.
        const [row] = await prisma.$queryRaw<Array<{ ok: number }>>`
          SELECT 1 AS ok
        `;

        expect(row.ok).toBe(1);
      });

      await onBatchUrl(undefined, () => job.handler().catch(() => undefined));
    },
    60_000,
  );

  it("reads the database's numbers for the heartbeat on the batch pool", async () => {
    const { readClusterReadings } =
      await import("@/shared/health/cluster-sample");

    const readings = await onBatchUrl(closedUrl(), () =>
      readClusterReadings(new Date(), {
        readDatabase: (withSizes) =>
          collectDatabaseMetrics({
            client: databaseBatch,
            sizes: withSizes ? "fresh" : "skip",
          }),
      }),
    );

    // Fail-open as before: unread, and said so.
    expect(
      readings.database.collection_errors.map((error) => error.part),
    ).toContain("core");
  });
});

describe("the database's numbers a runtime login may not read", () => {
  it("come from the heartbeat's cluster row on /health/metrics", async () => {
    // The heartbeat of this minute: the readings on the batch pool, the
    // cluster row after the ping.
    await opsHeartbeatJob.handler();

    const live = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE ${PROBE_ROLE}`);

      return collectDatabaseMetrics({ client: tx, sizes: "skip" });
    });

    // What trajetto_http will see on its own.
    expect(live.stats_cluster_wide).toBe(false);
    expect(live.pg_wal.readable).toBe(false);

    const merged = await withClusterSample(live, prisma);

    expect(merged.stats_cluster_wide).toBe(true);
    expect(merged.pg_wal.readable).toBe(true);
    expect(merged.pg_wal.files).toBeGreaterThan(0);
    expect(merged.sampled_at).toEqual(expect.any(String));

    // Today's superuser reads it all live, and nothing is replaced.
    const superuser = await collectDatabaseMetrics({
      client: prisma,
      sizes: "skip",
    });

    expect((await withClusterSample(superuser, prisma)).sampled_at).toBe(
      undefined,
    );

    // Before F3-18 the probe's whole core statement failed (42501 on
    // shared_preload_libraries): the xid, the archiver and the hot tables
    // were all lost with it. Now only the preload list is unread, and
    // pg_stat_statements' state comes from the sample.
    expect(live.collection_errors).toEqual([]);
    expect(live.xid_age).not.toBeNull();
    expect(merged.pg_stat_statements).toBe(superuser.pg_stat_statements);
  });
});
