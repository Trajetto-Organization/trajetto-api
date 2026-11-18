import type pg from "pg";
import { randomUUID } from "node:crypto";
import { v7 as uuidV7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { openReleaseClient } from "infra/scripts/release-connection";
import { ActivityRepository } from "@/modules/activity/repositories/activity-repository";
import { createPrismaClient } from "@/shared/database/database-client";
import {
  grainStart,
  partitionName,
  registeredPartitions,
  type PartitionedTable,
} from "@/shared/database/partitions";
import { PROCESS_CAPABILITIES } from "@/shared/health/capabilities";

import {
  seedFleetDriver,
  type FleetDriverSeed,
} from "./support/fleet-driver-seed";
import {
  approvedEarlier,
  runHistoryWindow,
  unpartitionHistory,
} from "./support/history-window";

/**
 * The activity trail's shell and its copy window (plano-escala F2-18), on a
 * real Postgres: migrations 20261118140000 to 20261118140200,
 * prisma/post-deploy/31-activity-window.sql and
 * prisma/post-deploy/rollback/unpartition-activity.sql.
 *
 * The shell must hold everything the trail's readers and writers rely on,
 * or the swap changes behaviour: the columns, the two foreign keys, every
 * index, deliveryId as a plain one (a partitioned table holds no unique
 * without its key; the pipeline writes under the delivery's id, F2-15).
 * The window runs only inside the approved interval and once every live
 * process announces history-partition-agnostic-v1. It copies every row,
 * giving each id from before the uuid v7 switch the same v7 of its
 * created_at on every run (the old one resolves through activity_legacy for
 * 14 days); a writer that waited for the window lands in the new table
 * once; the feed's data version turns from 1 to 2; the way back gives the
 * old ids back without the re-keyed copies.
 */
const prisma = createPrismaClient();
const STEP = "31-activity-window.sql";
const OLD = new Date("2025-03-10T14:30:00.000Z");
const V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const activityEntry = registeredPartitions().find(
  (table) => table.table === "activity",
) as PartitionedTable;

let admin: pg.Client;
let seed: FleetDriverSeed;
const v4Ids: string[] = [];
const v7Ids: string[] = [];

async function rows<T extends pg.QueryResultRow>(
  sql: string,
  values: unknown[] = [],
): Promise<T[]> {
  return (await admin.query<T>(sql, values)).rows;
}

async function kind(table: string): Promise<string | null> {
  const [row] = await rows<{ kind: string | null }>(
    "SELECT (SELECT relkind::text FROM pg_class WHERE oid = to_regclass($1)) AS kind",
    [table],
  );

  return row.kind;
}

/** The table's columns: name, type, default and NOT NULL, in order. */
async function columns(table: string) {
  return rows(
    `SELECT a.attname::text AS name, format_type(a.atttypid, a.atttypmod) AS type,
            pg_get_expr(d.adbin, d.adrelid) AS "default", a.attnotnull AS not_null
       FROM pg_attribute a
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = to_regclass($1) AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`,
    [table],
  );
}

/** Foreign keys by name with the table's prefix taken out. */
async function foreignKeys(table: string): Promise<Record<string, string>> {
  const found = await rows<{ name: string; def: string }>(
    `SELECT conname::text AS name, pg_get_constraintdef(oid) AS def
       FROM pg_constraint WHERE conrelid = to_regclass($1) AND contype = 'f'`,
    [table],
  );

  return Object.fromEntries(
    found.map((row) => [row.name.replace(`${table}_`, "<t>_"), row.def]),
  );
}

/** Indexes by name with the table's prefix taken out, and their keys. */
async function indexes(table: string): Promise<Record<string, string>> {
  const found = await rows<{ name: string; keys: string; unique: boolean }>(
    `SELECT ic.relname::text AS name, i.indisunique AS unique,
            pg_get_indexdef(i.indexrelid, 0, true) AS keys
       FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
      WHERE i.indrelid = to_regclass($1)`,
    [table],
  );

  return Object.fromEntries(
    found.map((row) => [
      row.name.replace(`${table}_`, "<t>_"),
      `${row.unique ? "unique " : ""}${row.keys.replace(/^.* USING /, "")}`,
    ]),
  );
}

/** One row of the trail written by raw SQL, with `id` and `created_at`. */
async function insert(id: string, createdAt: Date, description: string) {
  await admin.query(
    `INSERT INTO "activity" ("id", "type", "action", "entityId", "description", "status",
                             "businessId", "performedBy", "created_at", "updated_at")
     VALUES ($1, 'vehicle', 'create', $2, $3, 'Criado', $4, $5, $6::timestamp, $6::timestamp)`,
    // In UTC, as Prisma writes the column (a timestamp without zone).
    [
      id,
      randomUUID(),
      description,
      seed.businessId,
      seed.driverUserId,
      createdAt.toISOString().replace("T", " ").replace("Z", ""),
    ],
  );
}

/** Until a session of `applicationName` waits for a lock. */
async function waitingOnALock(applicationName: string): Promise<void> {
  await vi.waitFor(
    async () => {
      const waiting = await rows(
        `SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
          WHERE a.application_name = $1 AND NOT l.granted`,
        [applicationName],
      );

      expect(waiting.length).toBeGreaterThan(0);
    },
    { timeout: 8_000, interval: 50 },
  );
}

async function sample(replica: string, capabilities: readonly string[]) {
  await prisma.opsSample.create({
    data: {
      ts: new Date(),
      role: "all",
      replica,
      commit: null,
      metrics: { v: 1, capabilities: [...capabilities] },
    },
  });
}

beforeAll(async () => {
  admin = await openReleaseClient(
    process.env.DATABASE_URL as string,
    "e2e-history-window-activity",
  );

  seed = await seedFleetDriver(prisma, {
    businessId: "019a9a40-0000-7000-8000-00000000000a",
    cnpj: "55666650000191",
  });

  // From before the switch to uuid v7: random ids, a year and more ago.
  for (let i = 0; i < 3; i += 1) {
    const id = randomUUID();

    v4Ids.push(id);
    await insert(id, new Date(OLD.getTime() + i * 60_000), `antiga ${i}`);
  }

  for (let i = 0; i < 2; i += 1) {
    const id = uuidV7();

    v7Ids.push(id);
    await insert(id, new Date(), `nova ${i}`);
  }
}, 120_000);

afterAll(async () => {
  await admin?.end();
  await prisma.$disconnect();
});

describe("the shell against activity", () => {
  it("has the same columns, the two foreign keys and every index, deliveryId as a plain one", async () => {
    expect(await kind("activity_part")).toBe("p");
    expect(await columns("activity_part")).toEqual(await columns("activity"));
    expect(await foreignKeys("activity_part")).toEqual(
      await foreignKeys("activity"),
    );

    const plain = await indexes("activity");
    const shell = await indexes("activity_part");

    expect(plain["<t>_deliveryId_key"]).toBe('unique btree ("deliveryId")');
    expect(shell["<t>_deliveryId_idx"]).toBe('btree ("deliveryId")');

    delete plain["<t>_deliveryId_key"];
    delete shell["<t>_deliveryId_idx"];

    expect(shell).toEqual(plain);

    const [{ target }] = await rows<{ target: number }>(
      `SELECT attstattarget AS target FROM pg_attribute
        WHERE attrelid = 'activity_part'::regclass AND attname = 'businessId'`,
    );

    expect(target).toBe(1000);
  });
});

describe("outside the approved interval, or before the capability", () => {
  it("never runs the window, then waits for every live process", async () => {
    for (const settings of [{}, approvedEarlier()]) {
      const outcome = await runHistoryWindow(STEP, settings);

      expect(outcome.status).toBe("skipped");
      expect(outcome.detail).toMatch(/^aguardando janela/);
    }

    await sample("api-f218", ["queue-partition-agnostic-v1"]);

    const waiting = await runHistoryWindow(STEP);

    expect(waiting.status).toBe("pending");
    expect(waiting.detail).toContain("history-partition-agnostic-v1");
    expect(await kind("activity")).toBe("r");
    expect(await new ActivityRepository(prisma).dataVersion()).toBe("1");
  });
});

describe("inside it", () => {
  it("copies every row, re-keys the old ids to a v7 of their created_at, and a waiting writer lands once", async () => {
    await sample("api-f218", PROCESS_CAPABILITIES);

    const before = await rows<{ id: string; created_at: Date }>(
      `SELECT "id", "created_at" FROM "activity" WHERE "businessId" = $1`,
      [seed.businessId],
    );

    // A writer in flight when the window starts: the window waits for it.
    const inFlight = await openReleaseClient(
      process.env.DATABASE_URL as string,
      "e2e-activity-in-flight",
    );
    const waiter = await openReleaseClient(
      process.env.DATABASE_URL as string,
      "e2e-activity-waiter",
    );
    const inFlightId = uuidV7();
    const waiterId = uuidV7();

    try {
      await inFlight.query("BEGIN");
      await inFlight.query(
        `INSERT INTO "activity" ("id", "type", "action", "entityId", "description", "status", "businessId", "updated_at")
         VALUES ($1, 'vehicle', 'update', 'x', 'em voo', 'Atualizado', $2, now())`,
        [inFlightId, seed.businessId],
      );

      const window = runHistoryWindow(STEP);

      // The window asked for its lock; a writer that comes now waits
      // behind it, and lands in whichever table holds the name after it.
      await waitingOnALock("e2e-history-window");

      const waiting = waiter.query(
        `INSERT INTO "activity" ("id", "type", "action", "entityId", "description", "status", "businessId", "updated_at")
         VALUES ($1, 'vehicle', 'update', 'y', 'esperou a janela', 'Atualizado', $2, now())`,
        [waiterId, seed.businessId],
      );

      await waitingOnALock("e2e-activity-waiter");
      await inFlight.query("COMMIT");

      const outcome = await window;

      await waiting;

      expect(outcome.status, outcome.detail).toBe("applied");
      expect(outcome.detail).toMatch(/pausa de escrita de [\d.]+ s/);
      expect(outcome.detail).toContain(
        `${v4Ids.length} id(s) de antes do v7 re-chaveados`,
      );
    } finally {
      await inFlight.end();
      await waiter.end();
    }

    expect(await kind("activity")).toBe("p");
    expect(await kind("activity_legacy")).toBe("r");
    expect(await kind("activity_part")).toBeNull();

    const after = await rows<{
      id: string;
      description: string;
      partition: string;
    }>(
      `SELECT "id", "description", tableoid::regclass::text AS partition
         FROM "activity" WHERE "businessId" = $1`,
      [seed.businessId],
    );

    // Every id a v7; the copied ones, the in-flight one and the waiter, each once.
    expect(after.every((row) => V7.test(row.id))).toBe(true);
    expect(after).toHaveLength(before.length + 2);
    expect(after.filter((row) => row.id === inFlightId)).toHaveLength(1);
    expect(after.filter((row) => row.id === waiterId)).toHaveLength(1);

    // The waiter wrote after the window: only in the new table.
    expect(
      await rows(`SELECT 1 FROM "activity_legacy" WHERE "id" = $1`, [waiterId]),
    ).toHaveLength(0);

    // The v7 ids as they were; each old one under the v7 of its
    // created_at, which the support query gives back from the old id.
    for (const id of v7Ids) {
      expect(after.some((row) => row.id === id)).toBe(true);
    }

    for (const old of v4Ids) {
      const [mapped] = await rows<{ new_id: string; ms: string }>(
        `SELECT trajetto_activity_rekey(l."id", l."created_at") AS new_id,
                floor(extract(epoch FROM l."created_at") * 1000)::bigint::text AS ms
           FROM "activity_legacy" l WHERE l."id" = $1`,
        [old],
      );
      const copy = after.find((row) => row.id === mapped.new_id);

      expect(copy, old).toBeDefined();
      // The instant of created_at (UTC), as a uuid v7 starts.
      expect(mapped.new_id.slice(0, 13).replace("-", "")).toBe(
        BigInt(mapped.ms).toString(16).padStart(12, "0"),
      );
      expect(Number(mapped.ms)).toBeGreaterThanOrEqual(OLD.getTime());
      expect(copy?.partition).toBe("activity_older");
    }

    expect(after.find((row) => row.id === v7Ids[0])?.partition).toBe(
      partitionName(activityEntry, grainStart("month", new Date())),
    );

    // No unique on deliveryId any more: a plain index, under its name.
    const [deliveryIndex] = await rows<{ unique: boolean }>(
      `SELECT indisunique AS unique FROM pg_index WHERE indexrelid = to_regclass('"activity_deliveryId_idx"')`,
    );

    expect(deliveryIndex).toEqual({ unique: false });
    expect(await new ActivityRepository(prisma).dataVersion()).toBe("2");
  }, 60_000);

  it("keeps one row per notification delivery, under its id", async () => {
    const deliveryId = uuidV7();
    const entry = {
      type: "Entrega",
      action: "update",
      entityId: randomUUID(),
      description: "Entrega saiu para rota",
      status: "Atualizado",
      performedBy: seed.driverUserId,
      businessId: seed.businessId,
      deliveryId,
    };

    const results = await Promise.all(
      [1, 2, 3].map(() => new ActivityRepository(prisma).createActivity(entry)),
    );

    expect(new Set(results.map((row) => row.id))).toEqual(
      new Set([deliveryId]),
    );
    expect(await prisma.activity.count({ where: { deliveryId } })).toBe(1);
  });

  it("re-keys the same way on every run, and a second run does nothing", async () => {
    const [first] = await rows<{ id: string }>(
      `SELECT trajetto_activity_rekey($1, $2::timestamp) AS id`,
      [v4Ids[0], "2025-03-10 14:30:00"],
    );
    const [again] = await rows<{ id: string }>(
      `SELECT trajetto_activity_rekey($1, $2::timestamp) AS id`,
      [v4Ids[0], "2025-03-10 14:30:00"],
    );

    expect(first.id).toBe(again.id);
    expect(first.id).toMatch(V7);

    const outcome = await runHistoryWindow(STEP);

    expect(outcome.status).toBe("skipped");
    expect(outcome.detail).toContain("já é particionado");
  });
});

describe("the way back", () => {
  it("gives the old ids back, the rows written after the window once, and holds the window", async () => {
    const newIds = (
      await rows<{ id: string }>(
        `SELECT "id" FROM "activity" WHERE "businessId" = $1 ORDER BY "id"`,
        [seed.businessId],
      )
    ).map((row) => row.id);

    const notice = await unpartitionHistory("activity");

    expect(notice).toMatch(/^applied: activity voltou a ser comum/);
    expect(await kind("activity")).toBe("r");
    expect(await kind("activity_part")).toBe("p");

    const back = (
      await rows<{ id: string }>(
        `SELECT "id" FROM "activity" WHERE "businessId" = $1`,
        [seed.businessId],
      )
    ).map((row) => row.id);

    // The old ids, not their re-keyed copies; nothing twice.
    for (const old of v4Ids) expect(back).toContain(old);
    expect(new Set(back).size).toBe(back.length);
    expect(back).toHaveLength(newIds.length);
    expect(await new ActivityRepository(prisma).dataVersion()).toBe("1");

    const held = await runHistoryWindow(STEP);

    expect(held.status).toBe("skipped");
    expect(held.detail).toContain("trajetto:window-hold");
  });

  it("re-keys to the same ids when a new window runs", async () => {
    const [expected] = await rows<{ id: string }>(
      `SELECT trajetto_activity_rekey("id", "created_at") AS id FROM "activity" WHERE "id" = $1`,
      [v4Ids[1]],
    );

    await admin.query(`COMMENT ON TABLE "activity" IS NULL`);

    const outcome = await runHistoryWindow(STEP);

    expect(outcome.status, outcome.detail).toBe("applied");
    expect(
      await rows(`SELECT 1 FROM "activity" WHERE "id" = $1`, [expected.id]),
    ).toHaveLength(1);

    await unpartitionHistory("activity", { hold: false });
    expect(await kind("activity")).toBe("r");
  });
});
