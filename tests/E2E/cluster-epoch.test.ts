import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openReleaseClient } from "infra/scripts/release-connection";
import {
  listReleaseSteps,
  runReleaseSteps,
} from "infra/scripts/release-step-runner";
import { collectAlerts } from "@/shared/health/alert-rules";
import {
  clusterEpochStaleReason,
  readClusterEpochState,
} from "@/shared/health/cluster-epoch";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * The cluster's epoch on a real Postgres (plano-escala U-14).
 *
 * After a PITR or a failover the transaction ids are handed out again, and
 * the integration feed's cursor (F2-04) tells the two histories apart by
 * the epoch in cluster_epoch. The release step bumps it when the cluster's
 * system_identifier or timeline changed (infra/sql/50-cluster-epoch.sql),
 * and the ops heartbeat alerts cluster-epoch-stale in between. A promote
 * cannot happen inside a test, so it is simulated the other way round: the
 * row is moved off the cluster's pair, which is what a promote does from
 * the row's point of view.
 */
const prisma = createPrismaClient();
const STEP = resolve(process.cwd(), "infra/sql/50-cluster-epoch.sql");

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "trajetto-cluster-epoch-"));
  mkdirSync(join(root, "infra", "sql"), { recursive: true });
  copyFileSync(STEP, join(root, "infra", "sql", "50-cluster-epoch.sql"));
});

afterAll(async () => {
  rmSync(root, { recursive: true, force: true });
  await prisma.$disconnect();
});

/** The release step, with only the epoch's file. */
async function releaseStep(): Promise<{ status: string; detail: string }> {
  const client = await openReleaseClient(
    process.env.DATABASE_URL as string,
    "e2e-cluster-epoch",
  );

  try {
    const outcome = await runReleaseSteps(client, listReleaseSteps(root), {
      log: { info: () => undefined, warn: () => undefined },
      postDeploy: false,
    });

    const [step] = outcome.steps;

    return { status: step.status, detail: step.detail };
  } finally {
    await client.end();
  }
}

async function epoch(): Promise<number> {
  const [row] = await prisma.$queryRaw<Array<{ epoch: number }>>`
    SELECT "epoch" FROM "cluster_epoch" WHERE "id" = 1
  `;

  return row.epoch;
}

function alertCodes(
  clusterEpoch: Awaited<ReturnType<typeof readClusterEpochState>>,
): string[] {
  return collectAlerts({
    now: new Date(),
    outboxEligibleLagSec: null,
    deliveryEligibleLagSec: { internal: null, external: null },
    webhookDueLagSec: null,
    aiEligibleLagSec: null,
    deliveryFailures: [],
    aiCredentialFailures: 0,
    cronJobs: [],
    partitionRunwayOk: true,
    partitionRunwayDays: 7,
    stuckWorkers: [],
    connectionUsagePercent: 1,
    redisOk: true,
    ...(clusterEpoch && { clusterEpoch }),
    collectionErrors: [],
  }).map((alert) => alert.code);
}

describe("the cluster's epoch", () => {
  it("is in the E2E template, written by the release step, and matches the cluster", async () => {
    const state = await readClusterEpochState(prisma);

    expect(state?.stored?.epoch).toBeGreaterThanOrEqual(1);
    expect(clusterEpochStaleReason(state!)).toBeNull();
    expect(await releaseStep()).toMatchObject({ status: "skipped" });
  });

  it("is read by trajetto_batch, the pool the heartbeat uses after the cut of the roles", async () => {
    // pg_control_system() and pg_control_checkpoint() are PUBLIC on
    // Postgres 16, and cluster_epoch is one of the release's tables the
    // runtime may read: the per-minute check survives the cut.
    const state = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE trajetto_batch");

      return readClusterEpochState(tx);
    });

    expect(state?.stored).not.toBeNull();
    expect(state?.current.systemIdentifier).toMatch(/^\d+$/);
    expect(state?.current.timeline).toBeGreaterThanOrEqual(1);
  });

  it("goes up after a promote, and the alert fires until the step runs", async () => {
    const before = await epoch();

    // A promote, seen from the row: the timeline it was taken on is gone.
    await prisma.$executeRaw`
      UPDATE "cluster_epoch" SET "timeline" = "timeline" + 7 WHERE "id" = 1
    `;

    const stale = await readClusterEpochState(prisma);

    expect(clusterEpochStaleReason(stale!)).toMatch(/timeline/);
    expect(alertCodes(stale)).toEqual(["cluster-epoch-stale"]);

    expect(await releaseStep()).toMatchObject({
      status: "applied",
      detail: expect.stringContaining(`época ${before} para ${before + 1}`),
    });
    expect(await epoch()).toBe(before + 1);

    const fresh = await readClusterEpochState(prisma);

    expect(alertCodes(fresh)).toEqual([]);

    // And once is enough: the next release finds the pair it wrote.
    expect(await releaseStep()).toMatchObject({ status: "skipped" });
    expect(await epoch()).toBe(before + 1);
  });

  it("goes up on a new cluster too: the system identifier changed", async () => {
    const before = await epoch();

    await prisma.$executeRaw`
      UPDATE "cluster_epoch" SET "system_identifier" = 1 WHERE "id" = 1
    `;

    expect(
      clusterEpochStaleReason((await readClusterEpochState(prisma))!),
    ).toMatch(/system_identifier 1 → /);

    expect(await releaseStep()).toMatchObject({ status: "applied" });
    expect(await epoch()).toBe(before + 1);
    expect(
      clusterEpochStaleReason((await readClusterEpochState(prisma))!),
    ).toBeNull();
  });

  it("starts at 1 when the row is missing, alerting until then", async () => {
    await prisma.$executeRaw`DELETE FROM "cluster_epoch"`;

    const missing = await readClusterEpochState(prisma);

    expect(missing?.stored).toBeNull();
    expect(alertCodes(missing)).toEqual(["cluster-epoch-stale"]);

    expect(await releaseStep()).toMatchObject({
      status: "applied",
      detail: expect.stringContaining("época 1"),
    });
    expect(await epoch()).toBe(1);
  });

  it("keeps one row: a second id is refused by the database", async () => {
    await expect(
      prisma.$executeRaw`
        INSERT INTO "cluster_epoch" ("id", "epoch", "system_identifier", "timeline", "changed_at")
        VALUES (2, 1, 1, 1, now())
      `,
    ).rejects.toThrow(/cluster_epoch_single_row/);
  });
});
