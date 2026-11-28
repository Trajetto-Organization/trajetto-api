import { randomUUID } from "node:crypto";

import type pg from "pg";
import { v7 as uuidV7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { databaseBatch } from "infra/database";
import { openReleaseClient } from "infra/scripts/release-connection";
import {
  maintainPartitions,
  partitionArchiveJobs,
} from "@/jobs/cron/partition-maintenance-job";
import { env } from "@/env";
import {
  createHistoryArchiveScheduler,
  createHistoryDropGate,
} from "@/shared/archive/history-archive";
import { InMemoryArchiveStorage } from "@/shared/archive/in-memory-archive-storage";
import { createPrismaClient } from "@/shared/database/database-client";
import {
  grainStart,
  registeredPartitions,
  type PartitionedTable,
} from "@/shared/database/partitions";
import { PROCESS_CAPABILITIES } from "@/shared/health/capabilities";
import { uuid7Instant } from "@/shared/time/uuid7-floor";
import { BackgroundJobRepository } from "@/shared/jobs/background-job-repository";
import { JobRunner } from "@/shared/jobs/job-runner";
import { createPartitionArchiveJob } from "@/shared/jobs/partition-archive";

import { seedFleetDriver } from "./support/fleet-driver-seed";
import { runHistoryWindow } from "./support/history-window";

/**
 * The history's DROP (plano-escala F5-17), against Postgres, with the
 * archive bucket faked in memory.
 *
 * A partition of delivery_event or activity leaves the database only when
 * HISTORY_DROP_ENABLED is on, HISTORY_ATTACHED_MONTHS after it ends, and
 * only through its gate:
 *
 *  - with the flag off (the default), nothing is detached, not even with a
 *    registry that says a partition is past its time, and not without the
 *    gate;
 *  - an archive verified before the partition became due is not enough:
 *    the final pass is enqueued (every object written again), and the
 *    partition goes on the night after it is verified;
 *  - a partition whose rows changed since its final archive is archived
 *    again and kept;
 *  - so is one whose company had a person anonymized after it was
 *    written (no count changes), and one being anonymized is kept;
 *  - after the DROP, the manifest and the objects stay: they are what is
 *    left of the month.
 *
 * The months here are the copy window's (run on this file's database): the
 * history of last year lands in `_older`. The retention is set so that
 * only `_older` is past it, whatever day of the month the test runs.
 */
const prisma = createPrismaClient();
const storage = new InMemoryArchiveStorage();

const OLD_MS = Date.parse("2025-03-10T12:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const LATER = () => Date.now() + 40 * DAY_MS;

let admin: pg.Client;
const BUSINESS = "019a9b30-0000-7000-8000-00000000000a";

/**
 * Days from the end of `_older` (the window's first month, as the shell's
 * migration made it) to today: `_older` is past a retention of this many
 * days, and the month after it is not, whatever day the test runs.
 */
let olderEndsAt = 0;

function retentionPastOlderOnly(now = new Date()): number {
  return Math.max(
    0,
    Math.floor((grainStart("day", now).getTime() - olderEndsAt) / DAY_MS),
  );
}

/** The two history tables, as the registry has them with the DROP on. */
function historyTables(retentionDays: number | null): PartitionedTable[] {
  return registeredPartitions({ ...env, HISTORY_DROP_ENABLED: true })
    .filter((table) => table.archive === "history")
    .map((table) => ({ ...table, retentionDays }));
}

async function rows<T extends pg.QueryResultRow>(
  sql: string,
  values: unknown[] = [],
): Promise<T[]> {
  return (await admin.query<T>(sql, values)).rows;
}

async function attached(name: string): Promise<boolean> {
  const [row] = await rows<{ attached: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_inherits i WHERE i.inhrelid = to_regclass(quote_ident($1))
     ) AS attached`,
    [name],
  );

  return row.attached;
}

async function exists(name: string): Promise<boolean> {
  const [row] = await rows<{ present: boolean }>(
    "SELECT to_regclass(quote_ident($1)) IS NOT NULL AS present",
    [name],
  );

  return row.present;
}

function runner() {
  const instance = new JobRunner({
    store: new BackgroundJobRepository(databaseBatch),
    owner: () => "e2e",
  });

  instance.register(
    "PARTITION_ARCHIVE",
    createPartitionArchiveJob({ db: databaseBatch, storage: () => storage }),
  );

  return instance;
}

async function drainJobs(): Promise<void> {
  for (let round = 0; round < 50; round++) {
    if ((await runner().processBatch()) === 0) return;
  }

  throw new Error("os jobs de arquivo não terminaram");
}

const jobs = () =>
  partitionArchiveJobs(new BackgroundJobRepository(databaseBatch));

/** The archive's nights (F5-16) until every settled partition is verified. */
async function archiveEverything(): Promise<void> {
  for (let round = 0; round < 6; round++) {
    const queue = jobs();
    const outcome = await maintainPartitions({
      tables: historyTables(null),
      trailArchive: null,
      dropGates: {},
      historyDrop: null,
      historyArchive: createHistoryArchiveScheduler({
        db: databaseBatch,
        configured: true,
        now: LATER,
        enqueue: (table, partition) =>
          queue.enqueue(table, {
            name: partition.name,
            from: new Date(partition.from),
            to: new Date(partition.to),
          }),
      }),
    });

    await drainJobs();

    if (
      outcome.delivery_event.archiveQueued === 0 &&
      outcome.activity.archiveQueued === 0
    ) {
      return;
    }
  }

  throw new Error("o arquivo do histórico não acabou em seis noites");
}

/** A night of the DROP, with the history's gate at `retentionDays`. */
function dropNight(retentionDays: number) {
  return maintainPartitions({
    tables: historyTables(retentionDays),
    trailArchive: null,
    dropGates: {},
    historyArchive: null,
    historyDrop: createHistoryDropGate({
      db: databaseBatch,
      retentionDays,
      jobs: jobs(),
    }),
  });
}

beforeAll(async () => {
  admin = await openReleaseClient(
    process.env.DATABASE_URL as string,
    "e2e-history-drop",
  );

  await seedFleetDriver(prisma, {
    businessId: BUSINESS,
    cnpj: "55888870000515",
  });

  const shipper = await prisma.shipper.create({
    data: { name: "Embarcador", businessId: BUSINESS },
  });
  const delivery = await prisma.delivery.create({
    data: {
      id: uuidV7({ msecs: OLD_MS }),
      recipient_name: "Mercado Central",
      city: "São Paulo",
      uf: "SP",
      street: "Rua das Entregas",
      businessId: BUSINESS,
      shipperId: shipper.id,
    },
    select: { id: true },
  });

  for (const offset of [1, 2, 3]) {
    await admin.query(
      `INSERT INTO "delivery_event" ("id", "type", "note", "deliveryId", "businessId", "created_at")
       VALUES ($1, 'NOTE', 'do ano passado', $2, $3, $4)`,
      [
        uuidV7({ msecs: OLD_MS + offset }),
        delivery.id,
        BUSINESS,
        new Date(OLD_MS + offset),
      ],
    );
  }

  for (const description of ["um", "dois"]) {
    await admin.query(
      `INSERT INTO "activity" ("id", "type", "action", "entityId", "description", "status", "businessId", "created_at", "updated_at")
       VALUES ($1, 'Entrega', 'update', $2, $3, 'Atualizado', $4, $5, $5)`,
      [
        uuidV7({ msecs: OLD_MS }),
        randomUUID(),
        description,
        BUSINESS,
        new Date(OLD_MS),
      ],
    );
  }

  await prisma.opsSample.create({
    data: {
      ts: new Date(),
      role: "all",
      replica: "api-f517",
      commit: null,
      metrics: { v: 1, capabilities: [...PROCESS_CAPABILITIES] },
    },
  });

  for (const step of [
    "30-delivery-event-window.sql",
    "31-activity-window.sql",
  ] as const) {
    const outcome = await runHistoryWindow(step);

    expect(outcome.status, outcome.detail).toBe("applied");
  }

  const [bound] = await rows<{ bound: string }>(
    `SELECT pg_get_expr(c.relpartbound, c.oid) AS bound
       FROM pg_class c WHERE c.oid = to_regclass('delivery_event_older')`,
  );
  const upper = /TO \('([0-9a-f-]+)'\)/.exec(bound.bound)?.[1];

  olderEndsAt = uuid7Instant(upper ?? "") ?? 0;
  expect(olderEndsAt).toBeGreaterThan(0);

  await archiveEverything();
}, 240_000);

afterAll(async () => {
  await admin?.end();
  await prisma.$disconnect();
});

describe("with HISTORY_DROP_ENABLED off (the default)", () => {
  it("leaves the registry's history kept, and the job detaches nothing", async () => {
    for (const table of registeredPartitions().filter(
      (each) => each.archive === "history",
    )) {
      expect(table.retentionDays, table.table).toBeNull();
    }

    await maintainPartitions({ trailArchive: null, dropGates: {} });

    expect(await attached("delivery_event_older")).toBe(true);
    expect(await attached("activity_older")).toBe(true);
  });

  it("detaches nothing without the gate, even past the retention", async () => {
    const outcome = await maintainPartitions({
      tables: historyTables(retentionPastOlderOnly()),
      trailArchive: null,
      dropGates: {},
      historyArchive: null,
      historyDrop: null,
    });

    expect(outcome.delivery_event.held).toBeGreaterThan(0);
    expect(await attached("delivery_event_older")).toBe(true);
    expect(await attached("activity_older")).toBe(true);
  });
});

describe("with the DROP on, past HISTORY_ATTACHED_MONTHS", () => {
  it("keeps a partition archived before it became due, and enqueues its final pass", async () => {
    // As it is in production: archived when the month closed, months
    // before the DROP.
    await admin.query(
      `UPDATE "archive_partition" SET "verified_at" = '2000-01-01'
        WHERE "partition_name" = 'delivery_event_older'`,
    );
    await admin.query(
      `UPDATE "archive_manifest" SET "archived_at" = '2000-01-01'
        WHERE "partition_name" = 'delivery_event_older'`,
    );

    // activity: a row gone since its archive.
    await admin.query(
      `DELETE FROM "activity" WHERE "id" = (
         SELECT "id" FROM "activity" WHERE "businessId" = $1 ORDER BY "id" LIMIT 1)`,
      [BUSINESS],
    );

    const puts = storage.puts.length;
    const outcome = await dropNight(retentionPastOlderOnly());

    expect(outcome.delivery_event).toMatchObject({ dropped: 0 });
    expect(outcome.activity).toMatchObject({ dropped: 0 });
    expect(await attached("delivery_event_older")).toBe(true);
    expect(await attached("activity_older")).toBe(true);

    const queued = await rows<{ subject: string; rewrite: string | null }>(
      `SELECT "subjectId" AS subject, "payload"->>'rewriteBefore' AS rewrite
         FROM "background_job"
        WHERE "kind" = 'PARTITION_ARCHIVE' AND "status" = 'PENDING'
        ORDER BY 1`,
    );

    expect(queued.map((job) => job.subject)).toEqual([
      "activity_older",
      "delivery_event_older",
    ]);
    expect(queued.every((job) => job.rewrite !== null)).toBe(true);

    await drainJobs();

    // The final pass wrote every object again, from the rows as they are.
    expect(storage.puts.slice(puts).sort()).toEqual(
      [
        `archive/activity/older/${BUSINESS}.csv.gz`,
        `archive/delivery_event/older/${BUSINESS}.csv.gz`,
      ].sort(),
    );

    const [activity] = await rows<{ row_count: number }>(
      `SELECT "row_count" FROM "archive_manifest"
        WHERE "partition_name" = 'activity_older' AND "businessId" = $1`,
      [BUSINESS],
    );

    expect(activity.row_count).toBe(1);
  }, 120_000);

  it("keeps it while a person of it is anonymized, and archives it again after", async () => {
    // An anonymization changes no count: only its job says the rows were
    // scrubbed after the final pass wrote them.
    const anonymize = randomUUID();

    await admin.query(
      `INSERT INTO "background_job" ("id", "kind", "businessId", "subjectId", "status", "leaseExpiresAt")
       VALUES ($1, 'USER_ANONYMIZE', $2, $3, 'PROCESSING', now() + interval '1 hour')`,
      [anonymize, BUSINESS, randomUUID()],
    );

    const running = await dropNight(retentionPastOlderOnly());

    expect(running.delivery_event.dropped).toBe(0);
    expect(running.activity.dropped).toBe(0);
    expect(await attached("delivery_event_older")).toBe(true);

    const pending = async () =>
      rows<{ subject: string }>(
        `SELECT "subjectId" AS subject FROM "background_job"
          WHERE "kind" = 'PARTITION_ARCHIVE' AND "status" = 'PENDING'
          ORDER BY 1`,
      );

    expect(await pending()).toEqual([]);

    await admin.query(
      `UPDATE "background_job"
          SET "status" = 'SUCCEEDED', "finished_at" = now(), "leaseExpiresAt" = NULL
        WHERE "id" = $1`,
      [anonymize],
    );

    const puts = storage.puts.length;
    const finished = await dropNight(retentionPastOlderOnly());

    expect(finished.delivery_event.dropped).toBe(0);
    expect(finished.activity.dropped).toBe(0);
    expect(await attached("activity_older")).toBe(true);
    expect((await pending()).map((job) => job.subject)).toEqual([
      "activity_older",
      "delivery_event_older",
    ]);

    await drainJobs();

    // Written again from the scrubbed rows: the archive keeps nothing the
    // database no longer holds.
    expect(storage.puts.slice(puts).sort()).toEqual(
      [
        `archive/activity/older/${BUSINESS}.csv.gz`,
        `archive/delivery_event/older/${BUSINESS}.csv.gz`,
      ].sort(),
    );
  }, 120_000);

  it("drops it the night after, and keeps its manifest and its objects", async () => {
    const outcome = await dropNight(retentionPastOlderOnly());

    expect(outcome.delivery_event.dropped).toBe(1);
    expect(outcome.activity.dropped).toBe(1);
    expect(await exists("delivery_event_older")).toBe(false);
    expect(await exists("activity_older")).toBe(false);

    // Only `_older` was due: last month's partition is still there.
    const [left] = await rows<{ partitions: number }>(
      `SELECT count(*)::int AS partitions FROM pg_inherits
        WHERE inhparent = to_regclass('delivery_event')`,
    );

    expect(left.partitions).toBeGreaterThan(0);

    const manifest = await rows<{ partition_name: string; status: string }>(
      `SELECT "partition_name", "status"::text AS status FROM "archive_manifest"
        WHERE "partition_name" IN ('delivery_event_older', 'activity_older')
        ORDER BY 1`,
    );

    expect(manifest).toEqual([
      { partition_name: "activity_older", status: "ARCHIVED" },
      { partition_name: "delivery_event_older", status: "ARCHIVED" },
    ]);
    expect(
      storage.objects.has(`archive/delivery_event/older/${BUSINESS}.csv.gz`),
    ).toBe(true);
  }, 120_000);
});
