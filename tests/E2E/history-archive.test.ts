import { createHash, randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";

import type pg from "pg";
import { v7 as uuidV7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { databaseBatch } from "infra/database";
import { openReleaseClient } from "infra/scripts/release-connection";
import {
  maintainPartitions,
  partitionArchiveJobs,
} from "@/jobs/cron/partition-maintenance-job";
import {
  ACTIVITY_ARCHIVE_COLUMNS,
  DELIVERY_EVENT_ARCHIVE_COLUMNS,
  PLATFORM_SUBJECT,
  createHistoryArchiveScheduler,
} from "@/shared/archive/history-archive";
import {
  parseHistoryCsv,
  restoreHistoryArchive,
} from "@/shared/archive/history-restore";
import { InMemoryArchiveStorage } from "@/shared/archive/in-memory-archive-storage";
import { createPrismaClient } from "@/shared/database/database-client";
import { PROCESS_CAPABILITIES } from "@/shared/health/capabilities";
import { BackgroundJobRepository } from "@/shared/jobs/background-job-repository";
import { JobRunner } from "@/shared/jobs/job-runner";
import { createPartitionArchiveJob } from "@/shared/jobs/partition-archive";

import { seedFleetDriver } from "./support/fleet-driver-seed";
import { runHistoryWindow } from "./support/history-window";

/**
 * The delivery history's archive against Postgres, with the archive bucket
 * faked in memory (plano-escala F5-16).
 *
 * delivery_event and activity are partitioned by the copy windows of wave
 * 11 (run here on this file's own database), and the history of before
 * the window lands in their `_older` partitions. Then the night, as
 * partition-maintenance runs it, hands the closed partitions to their
 * PARTITION_ARCHIVE jobs, and the jobs run as the worker runs them:
 *
 *  - one object per company and partition, at
 *    `archive/<table>/<period>/<businessId>.csv.gz`, the platform's rows of
 *    activity under `_platform`, a company being purged SKIPPED;
 *  - a manifest that adds up: each object's sha256 is that of its bytes,
 *    its rows are the company's, and the partition is verified;
 *  - the CSV keeps NULL apart from "" and survives commas, quotes and
 *    line breaks;
 *  - a second night archives nothing again; an anonymization after the
 *    archive writes that company's object again, and only that one;
 *  - archive-restore brings a company's partition back into a table of
 *    its own, row for row, and refuses an object that does not match its
 *    manifest.
 */
const prisma = createPrismaClient();
const storage = new InMemoryArchiveStorage();

const OLD_MS = Date.parse("2025-06-10T12:00:00Z");

/** Far enough ahead that every partition before this month is settled. */
const LATER = () => Date.now() + 40 * 24 * 60 * 60 * 1000;

let admin: pg.Client;
let alfa = "";
let beta = "";
let gone = "";

async function rows<T extends pg.QueryResultRow>(
  sql: string,
  values: unknown[] = [],
): Promise<T[]> {
  return (await admin.query<T>(sql, values)).rows;
}

async function company(businessId: string, cnpj: string) {
  const seed = await seedFleetDriver(prisma, { businessId, cnpj });
  const shipper = await prisma.shipper.create({
    data: { name: "Embarcador", businessId },
  });
  const delivery = await prisma.delivery.create({
    data: {
      id: uuidV7({ msecs: OLD_MS }),
      recipient_name: "Mercado Central",
      city: "São Paulo",
      uf: "SP",
      street: "Rua das Entregas",
      businessId,
      shipperId: shipper.id,
    },
    select: { id: true },
  });

  return { seed, delivery: delivery.id };
}

/** An event of last year, with `note` as given (null, "", anything). */
async function oldEvent(
  businessId: string,
  deliveryId: string,
  note: string | null,
  offsetMs: number,
) {
  await admin.query(
    `INSERT INTO "delivery_event" ("id", "type", "note", "deliveryId", "businessId", "created_at")
     VALUES ($1, 'NOTE', $2, $3, $4, $5)`,
    [
      uuidV7({ msecs: OLD_MS + offsetMs }),
      note,
      deliveryId,
      businessId,
      new Date(OLD_MS + offsetMs),
    ],
  );
}

async function oldActivity(businessId: string | null, description: string) {
  await admin.query(
    `INSERT INTO "activity" ("id", "type", "action", "entityId", "description", "status", "businessId", "created_at", "updated_at")
     VALUES ($1, 'Entrega', 'update', $2, $3, 'Atualizado', $4, $5, $5)`,
    [
      uuidV7({ msecs: OLD_MS }),
      randomUUID(),
      description,
      businessId,
      new Date(OLD_MS),
    ],
  );
}

function runner() {
  const instance = new JobRunner({
    store: new BackgroundJobRepository(databaseBatch),
    owner: () => "e2e",
  });

  instance.register(
    "PARTITION_ARCHIVE",
    createPartitionArchiveJob({
      db: databaseBatch,
      storage: () => storage,
      pageSize: 2,
    }),
  );

  return instance;
}

/** Every PARTITION_ARCHIVE job until none is left. */
async function drainJobs(): Promise<void> {
  for (let round = 0; round < 50; round++) {
    if ((await runner().processBatch()) === 0) return;
  }

  throw new Error("os jobs de arquivo não terminaram");
}

/** One night, with the history archive on and every month settled. */
function night() {
  const jobs = partitionArchiveJobs(new BackgroundJobRepository(databaseBatch));

  return maintainPartitions({
    trailArchive: null,
    dropGates: {},
    historyArchive: createHistoryArchiveScheduler({
      db: databaseBatch,
      configured: true,
      now: LATER,
      enqueue: (table, partition) =>
        jobs.enqueue(table, {
          name: partition.name,
          from: new Date(partition.from),
          to: new Date(partition.to),
        }),
    }),
  });
}

/**
 * Nights until nothing is left to hand over: a night hands at most two
 * partitions per table, and which months are settled depends on the day
 * of the month the test runs.
 */
async function archiveEverything(): Promise<void> {
  for (let round = 0; round < 6; round++) {
    const outcome = await night();

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

async function manifestOf(partition: string) {
  return rows<{
    business_id: string;
    status: string;
    row_count: number;
    sha256: string | null;
    object_key: string;
  }>(
    `SELECT "businessId" AS business_id, "status"::text AS status, "row_count",
            "sha256", "object_key"
       FROM "archive_manifest" WHERE "partition_name" = $1
      ORDER BY "businessId"`,
    [partition],
  );
}

beforeAll(async () => {
  admin = await openReleaseClient(
    process.env.DATABASE_URL as string,
    "e2e-history-archive",
  );

  alfa = "019a9b20-0000-7000-8000-00000000000a";
  beta = "019a9b20-0000-7000-8000-00000000000b";
  gone = "019a9b20-0000-7000-8000-00000000000c";

  const a = await company(alfa, "55888870000272");
  const b = await company(beta, "55888870000353");
  const c = await company(gone, "55888870000434");

  // Alfa: a note with every character a CSV must survive, an empty one
  // and none at all.
  await oldEvent(alfa, a.delivery, 'recebido por "Zé", portaria\nfundos', 1);
  await oldEvent(alfa, a.delivery, "", 2);
  await oldEvent(alfa, a.delivery, null, 3);
  await oldEvent(beta, b.delivery, "um", 4);
  await oldEvent(beta, b.delivery, "dois", 5);
  await oldEvent(gone, c.delivery, "da que está saindo", 6);

  await oldActivity(alfa, "Entrega atualizada, com vírgula");
  await oldActivity(alfa, "Outra");
  await oldActivity(null, "Empresa criada pela plataforma");

  // A live process of this image: the windows wait for its capability.
  await prisma.opsSample.create({
    data: {
      ts: new Date(),
      role: "all",
      replica: "api-f516",
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

  // Being purged: its rows are a deleted company's (F3-26a).
  await admin.query(
    `UPDATE "business" SET "purge_state" = 'PURGING' WHERE "id" = $1`,
    [gone],
  );
}, 240_000);

afterAll(async () => {
  await admin?.query(`DROP SCHEMA IF EXISTS "archive_restore" CASCADE`);
  await admin?.end();
  await prisma.$disconnect();
});

describe("a night with the history archive on", () => {
  it("archives every closed partition, one object per company, with a manifest that adds up", async () => {
    const outcome = await night();

    expect(outcome.delivery_event.archiveQueued).toBeGreaterThan(0);
    expect(outcome.activity.archiveQueued).toBeGreaterThan(0);

    await drainJobs();
    await archiveEverything();

    const events = await manifestOf("delivery_event_older");

    expect(
      events.map((row) => [row.business_id, row.status, row.row_count]),
    ).toEqual(
      [
        [alfa, "ARCHIVED", 3],
        [beta, "ARCHIVED", 2],
        [gone, "SKIPPED", 1],
      ].sort(),
    );

    for (const row of events.filter((each) => each.status === "ARCHIVED")) {
      const key = `archive/delivery_event/older/${row.business_id}.csv.gz`;
      const object = storage.objects.get(key);

      expect(row.object_key).toBe(key);
      expect(object, key).toBeDefined();
      expect(createHash("sha256").update(object!).digest("hex")).toBe(
        row.sha256,
      );
    }

    expect(
      storage.objects.has(`archive/delivery_event/older/${gone}.csv.gz`),
    ).toBe(false);

    const activity = await manifestOf("activity_older");

    expect(activity.map((row) => [row.business_id, row.row_count])).toEqual(
      [
        [PLATFORM_SUBJECT, 1],
        [alfa, 2],
      ].sort(),
    );

    const verified = await rows<{ partition_name: string; row_count: string }>(
      `SELECT "partition_name", "row_count"::text AS row_count
         FROM "archive_partition"
        WHERE "partition_name" IN ('delivery_event_older', 'activity_older')
        ORDER BY 1`,
    );

    expect(verified).toEqual([
      { partition_name: "activity_older", row_count: "3" },
      { partition_name: "delivery_event_older", row_count: "6" },
    ]);
  }, 120_000);

  it("keeps NULL apart from an empty note, and every comma, quote and line break", async () => {
    const object = storage.objects.get(
      `archive/delivery_event/older/${alfa}.csv.gz`,
    )!;
    const [header, ...lines] = parseHistoryCsv(
      gunzipSync(object).toString("utf8"),
    );

    expect(header).toEqual([...DELIVERY_EVENT_ARCHIVE_COLUMNS]);

    const note = DELIVERY_EVENT_ARCHIVE_COLUMNS.indexOf("note");

    expect(lines.map((line) => line[note])).toEqual([
      'recebido por "Zé", portaria\nfundos',
      "",
      null,
    ]);

    const activity = storage.objects.get(
      `archive/activity/older/${PLATFORM_SUBJECT}.csv.gz`,
    )!;
    const [activityHeader] = parseHistoryCsv(
      gunzipSync(activity).toString("utf8"),
    );

    expect(activityHeader).toEqual([...ACTIVITY_ARCHIVE_COLUMNS]);
  });

  it("archives nothing again on the next night", async () => {
    const puts = storage.puts.length;
    const outcome = await night();

    expect(outcome.delivery_event.archiveQueued).toBe(0);
    expect(outcome.activity.archiveQueued).toBe(0);

    await drainJobs();

    expect(storage.puts).toHaveLength(puts);
  });

  it("writes again the object of a company with someone anonymized since, and only that one", async () => {
    await admin.query(
      `INSERT INTO "background_job" ("id", "kind", "businessId", "status", "payload", "finished_at", "updated_at")
       VALUES ($1, 'USER_ANONYMIZE', $2, 'SUCCEEDED', '{}', now(), now())`,
      [uuidV7(), alfa],
    );

    const before = [...storage.puts];
    const outcome = await night();

    expect(outcome.delivery_event.archiveQueued).toBe(1);

    await drainJobs();

    const rewritten = storage.puts.slice(before.length);

    expect(rewritten.sort()).toEqual(
      [
        `archive/activity/older/${alfa}.csv.gz`,
        `archive/delivery_event/older/${alfa}.csv.gz`,
      ].sort(),
    );
  }, 120_000);
});

describe("archive-restore", () => {
  it("brings a company's partition back into a table of its own, row for row", async () => {
    const result = await restoreHistoryArchive(
      {
        table: "delivery_event",
        period: "older",
        subject: alfa,
        into: "pedido_alfa",
      },
      { db: prisma, storage },
    );

    expect(result).toMatchObject({
      into: "archive_restore.pedido_alfa",
      rows: 3,
      key: `archive/delivery_event/older/${alfa}.csv.gz`,
    });

    const columns = DELIVERY_EVENT_ARCHIVE_COLUMNS.map(
      (c) => `"${c}"::text`,
    ).join(", ");
    const original = await rows(
      `SELECT ${columns} FROM "delivery_event" WHERE "businessId" = $1 ORDER BY "id"`,
      [alfa],
    );
    const restored = await rows(
      `SELECT ${columns} FROM "archive_restore"."pedido_alfa" ORDER BY "id"`,
    );

    expect(restored).toEqual(original);
  });

  it("refuses an object that does not match its manifest, and creates nothing", async () => {
    const key = `archive/delivery_event/older/${beta}.csv.gz`;
    const genuine = storage.objects.get(key)!;

    storage.objects.set(key, Buffer.concat([genuine, Buffer.from([0])]));

    await expect(
      restoreHistoryArchive(
        {
          table: "delivery_event",
          period: "older",
          subject: beta,
          into: "pedido_beta",
        },
        { db: prisma, storage },
      ),
    ).rejects.toThrow(/sha256/);

    storage.objects.set(key, genuine);

    const [made] = await rows<{ present: boolean }>(
      `SELECT to_regclass('archive_restore.pedido_beta') IS NOT NULL AS present`,
    );

    expect(made.present).toBe(false);

    // A company being purged has nothing to restore.
    await expect(
      restoreHistoryArchive(
        { table: "delivery_event", period: "older", subject: gone },
        { db: prisma, storage },
      ),
    ).rejects.toThrow(/SKIPPED/);
  });
});

describe("with the history archive off (the default)", () => {
  it("hands nothing to the jobs", async () => {
    const outcome = await maintainPartitions({
      trailArchive: null,
      dropGates: {},
    });

    expect(outcome.delivery_event.archiveQueued).toBe(0);
    expect(outcome.activity.archiveQueued).toBe(0);
  });
});
