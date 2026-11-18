import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";
import pg from "pg";
import { v7 as uuidV7 } from "uuid";

import { createPrismaClient } from "@/shared/database/database-client";
import { DELIVERY_EVENT_WRITER_BOUND_MS } from "@/modules/integration/feed-floor";

/**
 * The writers of delivery_event, bounded from their transaction's start
 * (plano-escala U-16, decision D66), on a real Postgres.
 *
 * The integration feed's floor (F2-05) never skips an event only if no
 * transaction inserts one long after it began: an INSERT into
 * delivery_event, or into its partitioned shell, more than 240 s into its
 * transaction fails with SQLSTATE TJ001 and rolls the transaction back.
 *
 * The plan's acceptance is "a writer open for 5 min fails, one open for 3
 * min passes". Waiting minutes is not a test, so this file's database
 * gets the same function under a 2 s bound (the triggers take the bound as
 * their argument), and the long writer sleeps 3 s; the bound the migration
 * really installs is checked apart, in the catalog.
 */
const prisma = createPrismaClient();

const CARRIER = "018f5b00-0000-7000-8000-00000000000a";
const SHIPPER = "018f5b00-0000-7000-8000-0000000000f1";

/** The bound this file's database runs under, in seconds. */
const TEST_BOUND_SECONDS = 2;

let deliveryId: string;
const sessions: pg.Client[] = [];

/** A plain session on this file's database, apart from Prisma's pool. */
async function session(): Promise<pg.Client> {
  const url = new URL(process.env.DATABASE_URL as string);

  url.searchParams.delete("schema");

  const client = new pg.Client({
    connectionString: url.toString(),
    connectionTimeoutMillis: 10_000,
    application_name: "writer-bound-e2e",
  });

  await client.connect();
  sessions.push(client);

  return client;
}

async function setBound(seconds: number): Promise<void> {
  for (const [name, table] of [
    ["delivery_event_writer_bound", "delivery_event"],
    ["delivery_event_part_writer_bound", "delivery_event_part"],
  ]) {
    await prisma.$executeRawUnsafe(
      `CREATE OR REPLACE TRIGGER "${name}" BEFORE INSERT ON "${table}" FOR EACH STATEMENT EXECUTE FUNCTION "trajetto_delivery_event_writer_bound"('${seconds}')`,
    );
  }
}

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora do Escritor Longo",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua das Transportadoras",
      address_number: "1",
      cnpj: "11222999000182",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `writer-bound-${randomUUID()}@example.com`,
    },
  });

  await prisma.shipper.create({
    data: { id: SHIPPER, name: "Embarcador", businessId: CARRIER },
  });

  const delivery = await prisma.delivery.create({
    data: {
      recipient_name: "Cliente",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      businessId: CARRIER,
      shipperId: SHIPPER,
    },
  });

  deliveryId = delivery.id;
}, 60_000);

afterAll(async () => {
  for (const client of sessions) await client.end().catch(() => undefined);
  await prisma.$disconnect();
});

/**
 * Opens a transaction, waits `waitSeconds` in it, then inserts one event
 * into `table`. Resolves with the SQLSTATE of the failure, or null.
 */
async function writeAfter(
  table: "delivery_event" | "delivery_event_part",
  waitSeconds: number,
  note: string,
): Promise<string | null> {
  const client = await session();

  await client.query("BEGIN");

  try {
    await client.query("SELECT pg_sleep($1)", [waitSeconds]);
    await client.query(
      `INSERT INTO "${table}" ("id", "type", "note", "deliveryId", "businessId") VALUES ($1, 'NOTE', $2, $3, $4)`,
      [uuidV7(), note, deliveryId, CARRIER],
    );
    await client.query("COMMIT");

    return null;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);

    return (error as { code?: string }).code ?? "unknown";
  }
}

async function notes(table: string): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{ note: string }>>(
    `SELECT "note" FROM "${table}" WHERE "businessId" = $1 ORDER BY "note"`,
    CARRIER,
  );

  return rows.map((row) => row.note);
}

describe("the triggers the migration installs", () => {
  it("check every INSERT of both tables, once per statement, at 240 s", async () => {
    const rows = await prisma.$queryRaw<
      Array<{
        table: string;
        name: string;
        enabled: string;
        argument: string;
        type: number;
      }>
    >`
      SELECT tgrelid::regclass::text AS "table", tgname AS name,
             tgenabled::text AS enabled, encode(tgargs, 'escape') AS argument,
             tgtype::int AS type
      FROM pg_trigger
      WHERE tgname IN ('delivery_event_writer_bound', 'delivery_event_part_writer_bound')
      ORDER BY tgname
    `;

    // tgtype: BEFORE (2) and INSERT (4), and no ROW bit (1): per statement.
    expect(
      rows.map(({ table, name, enabled, argument, type }) => ({
        table,
        name,
        enabled,
        argument,
        type,
      })),
    ).toEqual([
      {
        table: "delivery_event_part",
        name: "delivery_event_part_writer_bound",
        enabled: "O",
        argument: `${DELIVERY_EVENT_WRITER_BOUND_MS / 1000}\\000`,
        type: 6,
      },
      {
        table: "delivery_event",
        name: "delivery_event_writer_bound",
        enabled: "O",
        argument: `${DELIVERY_EVENT_WRITER_BOUND_MS / 1000}\\000`,
        type: 6,
      },
    ]);
  });
});

describe("a writer past the bound", () => {
  beforeAll(async () => {
    await setBound(TEST_BOUND_SECONDS);
  });

  it("fails with TJ001 and leaves nothing behind", async () => {
    expect(await writeAfter("delivery_event", 3, "long")).toBe("TJ001");
    expect(await notes("delivery_event")).not.toContain("long");
  }, 30_000);

  it("passes under the bound", async () => {
    expect(await writeAfter("delivery_event", 1, "short")).toBeNull();
    expect(await notes("delivery_event")).toContain("short");
  }, 30_000);

  it("is held to the same bound in the partitioned shell", async () => {
    expect(await writeAfter("delivery_event_part", 3, "long")).toBe("TJ001");
    expect(await writeAfter("delivery_event_part", 0, "short")).toBeNull();
    expect(await notes("delivery_event_part")).toEqual(["short"]);
  }, 30_000);

  it("counts from the transaction's start, not the statement's", async () => {
    // Three quick statements spread over 3 s: each one is fast, the
    // transaction is not.
    const client = await session();

    await client.query("BEGIN");
    await client.query(
      `INSERT INTO "delivery_event" ("id", "type", "note", "deliveryId", "businessId") VALUES ($1, 'NOTE', 'first', $2, $3)`,
      [uuidV7(), deliveryId, CARRIER],
    );
    await client.query("SELECT pg_sleep(3)");

    const late = await client
      .query(
        `INSERT INTO "delivery_event" ("id", "type", "note", "deliveryId", "businessId") VALUES ($1, 'NOTE', 'late', $2, $3)`,
        [uuidV7(), deliveryId, CARRIER],
      )
      .then(
        () => null,
        (error: { code?: string }) => error.code ?? "unknown",
      );

    await client.query("ROLLBACK");

    expect(late).toBe("TJ001");
    expect(await notes("delivery_event")).not.toContain("first");
  }, 30_000);
});
