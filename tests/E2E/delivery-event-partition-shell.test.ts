import { readFileSync } from "node:fs";
import { join } from "node:path";

import type pg from "pg";
import { v7 as uuidV7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openReleaseClient } from "infra/scripts/release-connection";
import { maintainPartitions } from "@/jobs/cron/partition-maintenance-job";
import { PARTITION_OWNER_ROLE } from "@/shared/database/partition-owner";
import {
  addGrains,
  grainStart,
  partitionName,
  registeredPartitions,
  type PartitionedTable,
} from "@/shared/database/partitions";
import { createPrismaClient } from "@/shared/database/database-client";
import { readPartitionStates } from "@/shared/health/operational-state";
import { uuid7Floor } from "@/shared/time/uuid7-floor";

import { seedFleetDriver } from "./support/fleet-driver-seed";

/**
 * The partitioned shell of the delivery trail (plano-escala F2-16).
 *
 * The copy window of wave 11 (F2-17) fills delivery_event_part from
 * delivery_event and swaps the names. Everything the trail's readers and
 * writers rely on must already be in the shell, or the swap changes
 * behaviour: the columns, the foreign keys (a delivery deleted takes its
 * trail; a user with events cannot be deleted), every index (the timeline,
 * the tower, the integration feed). So this file compares the shell with
 * the legacy table as the migrations left them, name for name, and the one
 * difference on purpose: client_submission_id is a plain index, because a
 * partitioned table holds no unique without its key (the key's uniqueness
 * lives in delivery_event_submission, F2-14).
 *
 * Then the partitions: the legacy one FROM (MINVALUE) to this month, a
 * month each from this one to three ahead, all owned by
 * trajetto_partitions; a row lands by its uuid v7 id; the nightly job keeps
 * three months ahead with id bounds and never detaches nor drops anything
 * of it. And the foreign keys' migrations wait for a busy referenced table
 * instead of failing.
 */
const URL = () => process.env.DATABASE_URL as string;
const DAY_MS = 24 * 60 * 60 * 1000;

const shell = registeredPartitions().find(
  (table) => table.table === "delivery_event_part",
) as PartitionedTable;

const prisma = createPrismaClient();

let admin: pg.Client;
let delivery: { id: string; businessId: string };

async function rows<T extends pg.QueryResultRow>(
  sql: string,
  values: unknown[] = [],
): Promise<T[]> {
  return (await admin.query<T>(sql, values)).rows;
}

/** The table's foreign keys and their definitions, by name. */
async function foreignKeys(table: string): Promise<Map<string, string>> {
  const found = await rows<{ name: string; def: string }>(
    `SELECT conname::text AS name, pg_get_constraintdef(oid) AS def
       FROM pg_constraint
      WHERE conrelid = to_regclass(quote_ident($1)) AND contype = 'f'`,
    [table],
  );

  return new Map(found.map((row) => [row.name, row.def]));
}

/** The table's indexes, each definition with the table's name taken out. */
async function indexes(table: string): Promise<Map<string, string>> {
  const found = await rows<{ name: string; def: string }>(
    `SELECT indexname::text AS name, indexdef AS def
       FROM pg_indexes
      WHERE schemaname = current_schema() AND tablename = $1`,
    [table],
  );

  return new Map(
    found.map((row) => [
      row.name.replace(`${table}_`, "<t>_"),
      row.def
        .split(`"${table}_`)
        .join('"<t>_')
        .split(` ${table}_`)
        .join(" <t>_")
        .replace(` ON ONLY public.${table} `, " ON <t> ")
        .replace(` ON public.${table} `, " ON <t> "),
    ]),
  );
}

async function partitions(): Promise<Map<string, string>> {
  const found = await rows<{ name: string; bound: string }>(
    `SELECT c.relname::text AS name, pg_get_expr(c.relpartbound, c.oid) AS bound
       FROM pg_inherits i
       JOIN pg_class c ON c.oid = i.inhrelid
      WHERE i.inhparent = '"delivery_event_part"'::regclass`,
  );

  return new Map(found.map((row) => [row.name, row.bound]));
}

beforeAll(async () => {
  admin = await openReleaseClient(URL(), "e2e-delivery-event-shell");

  const seed = await seedFleetDriver(prisma, {
    businessId: "019a8f30-0000-7000-8000-00000000000a",
    cnpj: "55999990000191",
  });
  const shipper = await prisma.shipper.create({
    data: { name: "Embarcador", businessId: seed.businessId },
  });

  delivery = await prisma.delivery.create({
    data: {
      recipient_name: "Mercado Central",
      city: "São Paulo",
      uf: "SP",
      street: "Rua das Entregas",
      businessId: seed.businessId,
      shipperId: shipper.id,
    },
    select: { id: true, businessId: true },
  });
}, 120_000);

afterAll(async () => {
  await admin?.end();
  await prisma.$disconnect();
});

describe("the shell against delivery_event", () => {
  it("has the same columns, types, defaults and NOT NULLs, in the same order", async () => {
    const columns = (table: string) =>
      rows(
        `SELECT column_name, data_type, udt_name, column_default, is_nullable
           FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = $1
          ORDER BY ordinal_position`,
        [table],
      );

    const legacy = await columns("delivery_event");

    expect(legacy.length).toBeGreaterThan(20);
    expect(await columns("delivery_event_part")).toEqual(legacy);
  });

  it("has the six foreign keys of delivery_event, with the same definitions", async () => {
    const legacy = await foreignKeys("delivery_event");
    const part = await foreignKeys("delivery_event_part");

    expect(legacy.size).toBe(6);
    expect([...part.keys()].sort()).toEqual(
      [...legacy.keys()]
        .map((name) => name.replace("delivery_event_", "delivery_event_part_"))
        .sort(),
    );

    for (const [name, def] of legacy) {
      // The legacy apiKeyId key was added NOT VALID on a full table; the
      // shell's is checked against an empty one. Same rule either way.
      expect(
        part.get(name.replace("delivery_event_", "delivery_event_part_")),
        name,
      ).toBe(def.replace(/ NOT VALID$/, ""));
    }
  });

  it("has every index of delivery_event, the feed's included, client_submission_id as a plain index", async () => {
    const legacy = await indexes("delivery_event");
    const part = await indexes("delivery_event_part");

    const expected = new Map(legacy);
    const unique = expected.get("<t>_client_submission_id_key");

    expect(unique).toMatch(/^CREATE UNIQUE INDEX /);
    expected.delete("<t>_client_submission_id_key");
    expected.set(
      "<t>_client_submission_id_idx",
      (unique as string)
        .replace("CREATE UNIQUE INDEX", "CREATE INDEX")
        .replace(
          "<t>_client_submission_id_key",
          "<t>_client_submission_id_idx",
        ),
    );

    expect(Object.fromEntries(part)).toEqual(Object.fromEntries(expected));
    expect(part.has("<t>_feed_idx")).toBe(true);
  });

  it("keeps the businessId statistics target of the legacy table", async () => {
    const [row] = await rows<{ target: number }>(
      `SELECT attstattarget::int AS target FROM pg_attribute
        WHERE attrelid = '"delivery_event_part"'::regclass AND attname = 'businessId'`,
    );

    expect(row.target).toBe(1000);
  });
});

describe("the shell's partitions", () => {
  it("are the legacy one up to this month and a month each up to three ahead, owned by trajetto_partitions", async () => {
    const month = grainStart("month", new Date());
    const attached = await partitions();

    expect(attached.get("delivery_event_part_legacy")).toBe(
      `FOR VALUES FROM (MINVALUE) TO ('${uuid7Floor(month)}')`,
    );

    for (let step = 0; step <= 3; step += 1) {
      const from = addGrains("month", month, step);
      const name = partitionName(shell, from);

      expect(attached.get(name), name).toBe(
        `FOR VALUES FROM ('${uuid7Floor(from)}') TO ('${uuid7Floor(addGrains("month", from, 1))}')`,
      );
    }

    const owners = await rows<{ name: string; owner: string }>(
      `SELECT c.relname::text AS name, pg_get_userbyid(c.relowner)::text AS owner
         FROM pg_partition_tree('"delivery_event_part"'::regclass) t
         JOIN pg_class c ON c.oid = t.relid
        WHERE c.relkind IN ('p', 'r')`,
    );

    expect(owners.length).toBe(attached.size + 1);
    for (const each of owners) {
      expect(each.owner, each.name).toBe(PARTITION_OWNER_ROLE);
    }
  });

  it("route a row by its uuid v7 id, and refuse what a foreign key would", async () => {
    const target = delivery;

    const now = uuidV7();
    const old = uuidV7({ msecs: Date.parse("2025-06-01T12:00:00Z") });

    await admin.query("BEGIN");

    try {
      for (const id of [now, old]) {
        await admin.query(
          `INSERT INTO "delivery_event_part" ("id", "type", "deliveryId", "businessId")
           VALUES ($1, 'NOTE', $2, $3)`,
          [id, target.id, target.businessId],
        );
      }

      const landed = await rows<{ id: string; partition: string }>(
        `SELECT id, tableoid::regclass::text AS partition FROM "delivery_event_part"
          WHERE id = ANY($1::text[])`,
        [[now, old]],
      );

      expect(
        Object.fromEntries(landed.map((row) => [row.id, row.partition])),
      ).toEqual({
        [now]: partitionName(shell, grainStart("month", new Date())),
        [old]: "delivery_event_part_legacy",
      });

      await expect(
        admin.query(
          `INSERT INTO "delivery_event_part" ("id", "type", "deliveryId", "businessId")
           VALUES ($1, 'NOTE', 'no-such-delivery', $2)`,
          [uuidV7(), target.businessId],
        ),
      ).rejects.toMatchObject({ code: "23503" });
    } finally {
      await admin.query("ROLLBACK");
    }
  });
});

describe("the nightly job on the shell", () => {
  it("keeps three months ahead with id bounds, and never detaches nor drops a partition of it", async () => {
    const later = new Date(
      addGrains("month", grainStart("month", new Date()), 2).getTime() +
        3 * DAY_MS,
    );

    const outcome = await maintainPartitions({ now: later, tables: [shell] });

    expect(outcome.delivery_event_part).toMatchObject({
      dropped: 0,
      missingNow: [],
    });
    expect(outcome.delivery_event_part.created).toBe(2);

    const attached = await partitions();
    const farthest = addGrains("month", grainStart("month", later), 3);

    expect(attached.get(partitionName(shell, farthest))).toBe(
      `FOR VALUES FROM ('${uuid7Floor(farthest)}') TO ('${uuid7Floor(addGrains("month", farthest, 1))}')`,
    );

    // Years later, still: the history is kept (decision D3).
    await maintainPartitions({
      now: new Date(later.getTime() + 3 * 365 * DAY_MS),
      tables: [shell],
    });

    const kept = await partitions();

    expect(kept.has("delivery_event_part_legacy")).toBe(true);
    for (const name of attached.keys()) {
      expect(kept.has(name), name).toBe(true);
    }
  });

  it("is read on /health/metrics as kept, with its months ahead", async () => {
    const states = await readPartitionStates();

    expect(states.delivery_event_part).toMatchObject({
      retention_days: null,
      runway_ok: true,
      lookahead_ok: true,
      stuck: [],
      owner_ok: true,
    });
    expect(states.delivery_event_part.lookahead_days).toBeGreaterThan(60);
  });
});

describe("a foreign key's migration", () => {
  it("waits for a busy referenced table and adds the key once it is free", async () => {
    const migration = readFileSync(
      join(
        process.cwd(),
        "prisma/migrations/20261117200400_delivery_event_part_reason_fk/migration.sql",
      ),
      "utf8",
    );

    await admin.query(
      `ALTER TABLE "delivery_event_part" DROP CONSTRAINT "delivery_event_part_reasonId_fkey"`,
    );

    // Another session writing the catalogue of reasons: ROW EXCLUSIVE, which
    // the key's SHARE ROW EXCLUSIVE waits for.
    const writer = await openReleaseClient(URL(), "e2e-reason-writer");

    try {
      await writer.query("BEGIN");
      await writer.query(
        `LOCK TABLE "status_change_reason" IN ROW EXCLUSIVE MODE`,
      );

      const started = Date.now();
      const released = new Promise<void>((resolve) => {
        setTimeout(() => {
          void writer.query("COMMIT").then(() => resolve());
        }, 2_500);
      });

      await admin.query(migration);
      await released;

      expect(Date.now() - started).toBeGreaterThanOrEqual(2_000);
    } finally {
      await writer.end();
    }

    expect(
      (await foreignKeys("delivery_event_part")).get(
        "delivery_event_part_reasonId_fkey",
      ),
    ).toBe(
      (await foreignKeys("delivery_event")).get("delivery_event_reasonId_fkey"),
    );

    // A second run finds it and changes nothing.
    await admin.query(migration);
  }, 60_000);
});
