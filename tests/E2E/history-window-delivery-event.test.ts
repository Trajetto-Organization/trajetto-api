import type pg from "pg";
import { v7 as uuidV7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openReleaseClient } from "infra/scripts/release-connection";
import { HISTORY_WINDOW_SETTING } from "infra/scripts/release-step-runner";
import { DeliveryRepository } from "@/modules/delivery/repositories/delivery-repository";
import { createPrismaClient } from "@/shared/database/database-client";
import {
  grainStart,
  partitionName,
  registeredPartitions,
  type PartitionedTable,
} from "@/shared/database/partitions";
import { PROCESS_CAPABILITIES } from "@/shared/health/capabilities";

import { seedFleetDriver } from "./support/fleet-driver-seed";
import {
  approvedEarlier,
  approvedNow,
  runHistoryWindow,
  unpartitionHistory,
} from "./support/history-window";

/**
 * The copy window of the delivery trail (plano-escala F2-17, D39, D68), on a
 * real Postgres: prisma/post-deploy/30-delivery-event-window.sql and its
 * way back, prisma/post-deploy/rollback/unpartition-delivery-event.sql.
 *
 * Outside the interval the owner approved (HISTORY_WINDOW_APPROVED), the
 * step never runs the window: no value, a past interval, a malformed one or
 * one longer than a day all end 'skipped: aguardando janela', the trail
 * plain. Inside it the step still waits, 'pending', for every live process
 * to announce history-partition-agnostic-v1. Then the rehearsal: every row
 * copied with its txid (NULL kept NULL, so a poller's v2 cursor neither
 * repeats nor skips), the submission keys the previous image wrote only on
 * the column caught up, the names swapped, the writer bound of U-16 on the
 * new table, the pause measured; writes and the timeline go on, a second
 * run does nothing, and the way back gives every row back, the ones written
 * after the window included.
 */
const prisma = createPrismaClient();
const STEP = "30-delivery-event-window.sql";
const OLD_MS = Date.parse("2025-06-01T12:00:00Z");

const trailEntry = registeredPartitions().find(
  (table) => table.table === "delivery_event",
) as PartitionedTable;

let admin: pg.Client;
let businessId: string;
let oldDelivery: string;
let newDelivery: string;
const eventIds: string[] = [];
let previousImageEvent: string;

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

/** Every row of `table` as (id, txid), in id order. */
async function trail(table: string): Promise<Array<[string, string | null]>> {
  const found = await rows<{ id: string; txid: string | null }>(
    `SELECT "id", "txid"::text AS txid FROM "${table}" WHERE "businessId" = $1 ORDER BY "id"`,
    [businessId],
  );

  return found.map((row) => [row.id, row.txid]);
}

/** One ops_sample row for `replica`, announcing `capabilities`. */
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
    "e2e-history-window",
  );

  const seed = await seedFleetDriver(prisma, {
    businessId: "019a9a10-0000-7000-8000-00000000000a",
    cnpj: "55888870000191",
  });

  businessId = seed.businessId;

  const shipper = await prisma.shipper.create({
    data: { name: "Embarcador", businessId },
  });
  const deliveryData = {
    recipient_name: "Mercado Central",
    city: "São Paulo",
    uf: "SP",
    street: "Rua das Entregas",
    businessId,
    shipperId: shipper.id,
  };

  // A delivery of last year (its id is of then) and one of today.
  oldDelivery = (
    await prisma.delivery.create({
      data: { ...deliveryData, id: uuidV7({ msecs: OLD_MS }) },
      select: { id: true },
    })
  ).id;
  newDelivery = (
    await prisma.delivery.create({
      data: deliveryData,
      select: { id: true },
    })
  ).id;

  // From before the txid column: NULL, read by the feed as 0.
  const legacyRow = uuidV7({ msecs: OLD_MS + 3_600_000 });

  await admin.query(
    `INSERT INTO "delivery_event" ("id", "type", "note", "deliveryId", "businessId", "created_at", "txid")
     VALUES ($1, 'NOTE', 'do ano passado', $2, $3, $4, NULL)`,
    [legacyRow, oldDelivery, businessId, new Date(OLD_MS + 3_600_000)],
  );
  eventIds.push(legacyRow);

  for (const note of ["um", "dois", "três"]) {
    const event = await prisma.deliveryEvent.create({
      data: { type: "NOTE", note, deliveryId: newDelivery, businessId },
      select: { id: true },
    });

    eventIds.push(event.id);
  }

  // What the previous image wrote during the rolling deploy: the key on
  // the column only, no row in delivery_event_submission.
  previousImageEvent = uuidV7();
  await admin.query(
    `INSERT INTO "delivery_event" ("id", "type", "note", "deliveryId", "businessId", "client_submission_id")
     VALUES ($1, 'NOTE', 'imagem anterior', $2, $3, 'sub-previous-image-f217')`,
    [previousImageEvent, newDelivery, businessId],
  );
  eventIds.push(previousImageEvent);
}, 120_000);

afterAll(async () => {
  await admin?.end();
  await prisma.$disconnect();
});

describe("outside the approved interval", () => {
  it("never runs the window: no value, a past one, a malformed one, one longer than a day", async () => {
    const malformed = { [HISTORY_WINDOW_SETTING]: "amanhã de madrugada" };
    const tooLong = {
      [HISTORY_WINDOW_SETTING]: `${new Date(Date.now() - 60_000).toISOString()}/${new Date(Date.now() + 25 * 3_600_000).toISOString()}`,
    };

    for (const settings of [{}, approvedEarlier(), malformed, tooLong]) {
      const outcome = await runHistoryWindow(STEP, settings);

      expect(outcome.status, JSON.stringify(settings)).toBe("skipped");
      expect(outcome.detail).toMatch(/^aguardando janela/);
    }

    expect(await kind("delivery_event")).toBe("r");
    expect(await kind("delivery_event_part")).toBe("p");
    expect(await kind("delivery_event_legacy")).toBeNull();
  });
});

describe("inside the interval", () => {
  it("waits for every live process to announce the capability", async () => {
    await sample("api-f217-old", ["queue-partition-agnostic-v1"]);

    const outcome = await runHistoryWindow(STEP);

    expect(outcome.status).toBe("pending");
    expect(outcome.detail).toContain("history-partition-agnostic-v1");
    expect(await kind("delivery_event")).toBe("r");
  });

  it("copies every row with its txid, catches up the keys, and swaps the names", async () => {
    // The same replica, now on this image.
    await sample("api-f217-old", PROCESS_CAPABILITIES);

    const before = await trail("delivery_event");

    expect(before).toHaveLength(eventIds.length);
    expect(before.filter(([, txid]) => txid === null)).toHaveLength(1);

    const outcome = await runHistoryWindow(STEP);

    expect(outcome.status, outcome.detail).toBe("applied");
    expect(outcome.detail).toMatch(/pausa de escrita de [\d.]+ s/);
    expect(outcome.detail).toContain(`${eventIds.length} linhas copiadas`);

    expect(await kind("delivery_event")).toBe("p");
    expect(await kind("delivery_event_legacy")).toBe("r");
    expect(await kind("delivery_event_part")).toBeNull();

    // Every row, each with the txid it had: NULL is still NULL.
    expect(await trail("delivery_event")).toEqual(before);
    expect(await trail("delivery_event_legacy")).toEqual(before);

    // In its month: last year's in the partition FROM (MINVALUE).
    const landed = await rows<{ id: string; partition: string }>(
      `SELECT "id", tableoid::regclass::text AS partition FROM "delivery_event" WHERE "id" = ANY($1::text[])`,
      [eventIds],
    );
    const byId = Object.fromEntries(
      landed.map((row) => [row.id, row.partition]),
    );

    expect(byId[eventIds[0]]).toBe("delivery_event_older");
    expect(byId[eventIds[1]]).toBe(
      partitionName(trailEntry, grainStart("month", new Date())),
    );

    // The key the previous image wrote only on the column.
    const [claimed] = await rows<{ event_id: string }>(
      `SELECT event_id FROM "delivery_event_submission" WHERE client_submission_id = 'sub-previous-image-f217'`,
    );

    expect(claimed?.event_id).toBe(previousImageEvent);

    // The canonical names on the new table, the old ones on the legacy.
    const names = await rows<{ owner: string; name: string }>(
      `SELECT conrelid::regclass::text AS owner, conname::text AS name FROM pg_constraint
        WHERE conrelid IN (to_regclass('delivery_event'), to_regclass('delivery_event_legacy'))
          AND contype IN ('p', 'f')
        ORDER BY 1, 2`,
    );

    expect(names).toContainEqual({
      owner: "delivery_event",
      name: "delivery_event_pkey",
    });
    expect(names).toContainEqual({
      owner: "delivery_event",
      name: "delivery_event_deliveryId_fkey",
    });
    expect(names).toContainEqual({
      owner: "delivery_event_legacy",
      name: "delivery_event_legacy_pkey",
    });
    expect(names).toContainEqual({
      owner: "delivery_event_legacy",
      name: "delivery_event_legacy_deliveryId_fkey",
    });

    const feedIndex = await rows<{ table: string }>(
      `SELECT indrelid::regclass::text AS table FROM pg_index WHERE indexrelid = to_regclass('delivery_event_feed_idx')`,
    );

    expect(feedIndex).toEqual([{ table: "delivery_event" }]);

    // The writer bound of U-16 on the new table, at 240 s.
    const triggers = await rows<{
      table: string;
      name: string;
      argument: string;
    }>(
      `SELECT tgrelid::regclass::text AS table, tgname::text AS name, encode(tgargs, 'escape') AS argument
         FROM pg_trigger
        WHERE tgrelid IN (to_regclass('delivery_event'), to_regclass('delivery_event_legacy'))
          AND NOT tgisinternal
        ORDER BY 1`,
    );

    expect(triggers).toEqual([
      {
        table: "delivery_event",
        name: "delivery_event_writer_bound",
        argument: "240\\000",
      },
      {
        table: "delivery_event_legacy",
        name: "delivery_event_legacy_writer_bound",
        argument: "240\\000",
      },
    ]);
  });

  it("keeps the writes and the timeline going, and a second run does nothing", async () => {
    const after = await prisma.deliveryEvent.create({
      data: {
        type: "NOTE",
        note: "depois",
        deliveryId: oldDelivery,
        businessId,
      },
      select: { id: true },
    });

    eventIds.push(after.id);

    const detail = (await new DeliveryRepository(
      prisma as never,
    ).findDeliveryDetailById(oldDelivery)) as { events: Array<{ id: string }> };

    // Last year's event, in the partition FROM (MINVALUE), and today's.
    expect(detail.events.map((event) => event.id).sort()).toEqual(
      [eventIds[0], after.id].sort(),
    );

    const again = await runHistoryWindow(STEP);

    expect(again).toMatchObject({ status: "skipped" });
    expect(again.detail).toContain("já é particionada");
  });
});

describe("the way back", () => {
  it("gives every row back, the ones written after the window too, and holds the window", async () => {
    const before = await trail("delivery_event");

    const notice = await unpartitionHistory("delivery_event");

    expect(notice).toMatch(
      /^applied: delivery_event voltou a ser comum; 1 linha/,
    );
    expect(await kind("delivery_event")).toBe("r");
    expect(await kind("delivery_event_part")).toBe("p");
    expect(await kind("delivery_event_legacy")).toBeNull();
    expect(await trail("delivery_event")).toEqual(before);

    const [{ count }] = await rows<{ count: string }>(
      `SELECT count(*)::text AS count FROM "delivery_event_part"`,
    );

    expect(count).toBe("0");

    // Held by hand: the window leaves it plain.
    const held = await runHistoryWindow(STEP);

    expect(held.status).toBe("skipped");
    expect(held.detail).toContain("trajetto:window-hold");
  });

  it("lets a new window run once the hold is taken off", async () => {
    await admin.query(`COMMENT ON TABLE "delivery_event" IS NULL`);

    const outcome = await runHistoryWindow(STEP);

    expect(outcome.status, outcome.detail).toBe("applied");
    expect(await kind("delivery_event")).toBe("p");

    // Back to what the template has, for whoever runs after this file.
    await unpartitionHistory("delivery_event", { hold: false });
    expect(await kind("delivery_event")).toBe("r");
  });
});
