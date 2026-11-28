import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { ImportRepository } from "@/modules/import/repositories/import-repository";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * The day a delivery belongs to, marked dirty when it changes after being
 * counted (plano-escala F4-20, decision D52), on a real Postgres.
 *
 * The dashboard's rollup (F4-21) counts each closed day once; a delivery
 * deleted or moved to another status later changes a day already counted.
 * The triggers of migration 20261119130100 write that day into
 * tenant_day_dirty, and the job counts it again. Proven here:
 *
 *  - a status change marks the UTC day of the delivery's created_at, once
 *    per day, whatever the session's zone; a status written unchanged or
 *    another column changed marks nothing;
 *  - the import reversal (the plan's acceptance: "the reversal marks the
 *    day") marks the days of the deliveries it removes;
 *  - two transactions marking the same days in opposite orders never wait
 *    for each other (a unique key would make them deadlock);
 *  - the runtime roles write deliveries with the triggers on.
 *
 * The other half of the acceptance, "deleting the company does not fail",
 * is the purge's: tests/E2E/tenant-offboard.test.ts purges a company whose
 * deliveries' DELETEs mark their days, and ends with none of its rows in
 * either table.
 */
const prisma = createPrismaClient();
const imports = new ImportRepository(prisma);

const CARRIER = "018f5d20-0000-7000-8000-00000000000a";
const OTHER = "018f5d20-0000-7000-8000-00000000000b";
const SHIPPER = "018f5d20-0000-7000-8000-0000000000f1";
const DISPATCHER = "018f5d20-0000-7000-8000-0000000000a1";

const sessions: pg.Client[] = [];

/** A plain session on this file's database, apart from Prisma's pool. */
async function session(): Promise<pg.Client> {
  const url = new URL(process.env.DATABASE_URL as string);

  url.searchParams.delete("schema");

  const client = new pg.Client({
    connectionString: url.toString(),
    connectionTimeoutMillis: 10_000,
    application_name: "tenant-day-dirty-e2e",
  });

  await client.connect();
  sessions.push(client);

  return client;
}

async function seedCarrier(id: string, cnpj: string): Promise<void> {
  await prisma.business.create({
    data: {
      id,
      corporate_reason: `Transportadora ${id}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj,
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `${id}@exemplo.com.br`,
    },
  });
}

/** A delivery of CARRIER created at `createdAt` (an ISO instant, UTC). */
async function seedDelivery(
  createdAt: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const delivery = await prisma.delivery.create({
    data: {
      recipient_name: `Cliente ${randomUUID().slice(0, 6)}`,
      city: "São Paulo",
      uf: "SP",
      street: "Rua das Entregas",
      businessId: CARRIER,
      shipperId: SHIPPER,
      created_at: new Date(createdAt),
      ...overrides,
    },
  });

  return delivery.id;
}

/** The days marked for CARRIER, one entry per row, sorted. */
async function markedRows(): Promise<string[]> {
  const rows = await prisma.tenantDayDirty.findMany({
    where: { businessId: CARRIER },
    select: { day: true },
  });

  return rows.map((row) => row.day.toISOString().slice(0, 10)).sort();
}

/** Each test starts with no mark: the job (F4-21) would have taken them. */
async function clearMarks(): Promise<void> {
  await prisma.tenantDayDirty.deleteMany({});
}

beforeAll(async () => {
  await seedCarrier(CARRIER, "11222333000181");
  await seedCarrier(OTHER, "11222333000262");

  await prisma.user.create({
    data: {
      id: DISPATCHER,
      name: "Despachante",
      email: `${DISPATCHER}@exemplo.com.br`,
      password: "x",
      role: "BUSINESS_ADMIN",
      businessId: CARRIER,
    },
  });
  await prisma.shipper.create({
    data: { id: SHIPPER, name: "Embarcador", businessId: CARRIER },
  });
});

afterAll(async () => {
  await Promise.all(sessions.map((client) => client.end()));
  await prisma.$disconnect();
});

describe("a delivery whose status changes", () => {
  it("marks the UTC day of its created_at, once, whatever the session's zone", async () => {
    await clearMarks();

    // 02:30 in UTC is still the evening of the 2nd in São Paulo: the mark
    // is the UTC day, the one the trigger can tell without the company.
    const id = await seedDelivery("2026-10-03T02:30:00Z");
    const client = await session();

    await client.query("SET TIME ZONE 'America/Sao_Paulo'");
    await client.query(
      `UPDATE "delivery" SET "status" = 'IN_TRANSIT' WHERE "id" = $1`,
      [id],
    );
    await client.query(
      `UPDATE "delivery" SET "status" = 'DELIVERED' WHERE "id" = $1`,
      [id],
    );

    expect(await markedRows()).toEqual(["2026-10-03"]);

    // marked_at is a UTC instant without a zone, like every timestamp of
    // the schema, even from a session in another zone.
    const [mark] = await prisma.tenantDayDirty.findMany({
      where: { businessId: CARRIER },
    });

    expect(Math.abs(mark.marked_at.getTime() - Date.now())).toBeLessThan(
      10 * 60 * 1000,
    );
  });

  it("marks nothing when the status is written unchanged or another column changes", async () => {
    const id = await seedDelivery("2026-10-05T12:00:00Z");

    await clearMarks();

    await prisma.delivery.update({
      where: { id },
      data: { status: "PENDING" },
    });
    await prisma.delivery.update({
      where: { id },
      data: { recipient_name: "Outro nome", latitude: -23.5, longitude: -46.6 },
    });

    expect(await markedRows()).toEqual([]);
  });

  it("marks each day of a bulk change once, and only the company's", async () => {
    const ids = [
      await seedDelivery("2026-10-06T09:00:00Z"),
      await seedDelivery("2026-10-06T21:00:00Z"),
      await seedDelivery("2026-10-07T03:00:00Z"),
    ];

    await clearMarks();

    await prisma.delivery.updateMany({
      where: { id: { in: ids } },
      data: { status: "FAILED" },
    });

    expect(await markedRows()).toEqual(["2026-10-06", "2026-10-07"]);
    expect(
      await prisma.tenantDayDirty.count({ where: { businessId: OTHER } }),
    ).toBe(0);
  });
});

describe("a delivery deleted", () => {
  it("is marked by the import reversal, for each day it removes from", async () => {
    const record = await prisma.import.create({
      data: {
        source: "SPREADSHEET",
        filename: "entregas.xlsx",
        report: {},
        businessId: CARRIER,
        performedById: DISPATCHER,
      },
    });

    for (const createdAt of [
      "2026-09-10T12:00:00Z",
      "2026-09-10T15:00:00Z",
      "2026-09-11T01:00:00Z",
    ]) {
      await seedDelivery(createdAt, { importId: record.id });
    }

    await clearMarks();

    const result = await imports.reverseImport(record.id, CARRIER);

    expect(result).toMatchObject({ removedDeliveries: 3 });
    expect(await markedRows()).toEqual(["2026-09-10", "2026-09-11"]);
  });

  it("adds no row for a day already marked", async () => {
    const first = await seedDelivery("2026-09-20T10:00:00Z");
    const second = await seedDelivery("2026-09-20T11:00:00Z");

    await clearMarks();

    await prisma.delivery.delete({ where: { id: first } });
    await prisma.delivery.delete({ where: { id: second } });

    expect(await markedRows()).toEqual(["2026-09-20"]);
  });
});

describe("two writers marking the same days", () => {
  it("never wait for each other, in opposite orders", async () => {
    const [onFirst, onSecond, alsoSecond, alsoFirst] = [
      await seedDelivery("2026-08-01T12:00:00Z"),
      await seedDelivery("2026-08-02T12:00:00Z"),
      await seedDelivery("2026-08-02T13:00:00Z"),
      await seedDelivery("2026-08-01T13:00:00Z"),
    ];

    await clearMarks();

    const a = await session();
    const b = await session();

    // A wait on the other's open transaction would hit lock_timeout; under
    // a unique key on the day, the fourth UPDATE would deadlock instead.
    for (const client of [a, b]) {
      await client.query("SET lock_timeout = '1s'");
      await client.query("BEGIN");
    }

    const change = (client: pg.Client, id: string) =>
      client.query(
        `UPDATE "delivery" SET "status" = 'IN_TRANSIT' WHERE "id" = $1`,
        [id],
      );

    await change(a, onFirst);
    await change(b, onSecond);
    await change(a, alsoSecond);
    await change(b, alsoFirst);

    await a.query("COMMIT");
    await b.query("COMMIT");

    // Neither saw the other's mark before its commit, so each left its
    // own: two rows per day, which the job reads as one day.
    expect(await markedRows()).toEqual([
      "2026-08-01",
      "2026-08-01",
      "2026-08-02",
      "2026-08-02",
    ]);
  });
});

describe("the runtime roles", () => {
  it("change a status and delete a delivery with the triggers on", async () => {
    const client = await session();

    for (const role of ["trajetto_http", "trajetto_worker", "trajetto_batch"]) {
      const changed = await seedDelivery("2026-07-01T12:00:00Z");
      const deleted = await seedDelivery("2026-07-02T12:00:00Z");

      await clearMarks();

      await client.query("BEGIN");

      try {
        await client.query(`SET LOCAL ROLE ${role}`);
        await client.query(
          `UPDATE "delivery" SET "status" = 'CANCELLED' WHERE "id" = $1`,
          [changed],
        );
        await client.query(`DELETE FROM "delivery" WHERE "id" = $1`, [deleted]);

        const { rows } = await client.query<{ day: string }>(
          `SELECT "day"::text AS "day" FROM "tenant_day_dirty"
           WHERE "businessId" = $1 ORDER BY 1`,
          [CARRIER],
        );

        expect(
          rows.map((row) => row.day),
          role,
        ).toEqual(["2026-07-01", "2026-07-02"]);
      } finally {
        await client.query("ROLLBACK");
      }
    }
  });
});
