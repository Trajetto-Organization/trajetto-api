import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { randomUUID } from "node:crypto";

import { DriverPositionRepository } from "@/modules/route/repositories/driver-position-repository";
import { createPrismaClient } from "@/shared/database/database-client";

import { seedFleetDriver } from "./support/fleet-driver-seed";

/**
 * driver_last_position with HOT updates (plano-escala F2-13), on a real
 * Postgres.
 *
 * One row per driver, rewritten by every flush of positions. The old index
 * ("businessId", "recorded_at" DESC) held the column every rewrite changes,
 * so no update could be HOT: each one wrote a new entry in both indexes and
 * left a dead one for the vacuum, about 167 times a second at the peak.
 * With the index on ("businessId") alone and fillfactor 80, a rewrite
 * changes no indexed column and finds room on its own page. Measured here
 * through the repository's own upsert, one transaction per flush as the
 * app's are, and read from the table's statistics.
 */
const prisma = createPrismaClient();
const repository = new DriverPositionRepository();

const CARRIER = "018fe6b0-0000-7000-8000-00000000000a";
const DRIVERS = 40;
const FLUSHES = 25;

let drivers: string[] = [];

beforeAll(async () => {
  const seed = await seedFleetDriver(prisma, {
    businessId: CARRIER,
    cnpj: String(59000000000000 + Math.floor(Math.random() * 9000000)),
  });

  const created = await prisma.driver.createManyAndReturn({
    data: Array.from({ length: DRIVERS - 1 }, (_, index) => ({
      name: `Motorista ${index}`,
      birth_date: new Date("1990-01-01"),
      cnh: randomUUID().replace(/-/g, "").slice(0, 11),
      cpf: randomUUID().slice(0, 14),
      rg: randomUUID().slice(0, 12),
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      status: "ACTIVE" as const,
      contract_type: "OWNED" as const,
      businessId: CARRIER,
      branchId: seed.branchId,
    })),
    select: { id: true },
  });

  drivers = [seed.driverId, ...created.map((driver) => driver.id)];
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
});

async function updates(): Promise<{ all: number; hot: number }> {
  const [row] = await prisma.$queryRaw<Array<{ all: number; hot: number }>>`
    SELECT n_tup_upd::int AS all, n_tup_hot_upd::int AS hot
    FROM pg_stat_user_tables
    WHERE relid = 'driver_last_position'::regclass
  `;

  return row ?? { all: 0, hot: 0 };
}

describe("the drivers' last position", () => {
  it("is indexed by company only, with room left on each page", async () => {
    const indexes = await prisma.$queryRaw<Array<{ definition: string }>>`
      SELECT pg_get_indexdef(i.indexrelid) AS definition
      FROM pg_index i
      WHERE i.indrelid = 'driver_last_position'::regclass
      ORDER BY 1
    `;

    expect(indexes.map((index) => index.definition)).toEqual([
      `CREATE INDEX "driver_last_position_businessId_idx" ON public.driver_last_position USING btree ("businessId")`,
      `CREATE UNIQUE INDEX driver_last_position_pkey ON public.driver_last_position USING btree ("driverId")`,
    ]);

    const [table] = await prisma.$queryRaw<Array<{ options: string[] }>>`
      SELECT coalesce(reloptions, ARRAY[]::text[]) AS options
      FROM pg_class WHERE oid = 'driver_last_position'::regclass
    `;

    expect(table.options).toContain("fillfactor=80");
  });

  it("rewrites a driver's row as a HOT update, more than 9 in 10 times", async () => {
    const start = Date.now() - FLUSHES * 15_000;

    // The pruning a HOT update needs only removes versions below the oldest
    // transaction still running anywhere in the cluster: a write left open
    // in another file's database would stop it. So this file runs in the
    // one-file-at-a-time phase (tests/E2E/support/replica-files.ts).
    const before = await updates();

    // Flush after flush across the fleet, each a newer point: the first
    // round inserts the rows, every later one rewrites them.
    for (let flush = 0; flush < FLUSHES; flush += 1) {
      for (const driverId of drivers) {
        await repository.recordBatch({
          driverId,
          businessId: CARRIER,
          routeId: null,
          pings: [
            {
              latitude: -23.55 + flush * 0.0001,
              longitude: -46.63,
              accuracy: 5,
              speed: 30,
              heading: 90,
              battery: 80,
              recorded_at: new Date(start + flush * 15_000),
            },
          ],
        });
      }
    }

    const expected = DRIVERS * (FLUSHES - 1);

    // Each session reports its counters within seconds of its last
    // transaction, not at once.
    const after = await vi.waitFor(
      async () => {
        const now = await updates();

        if (now.all - before.all < expected) {
          throw new Error(`${now.all - before.all} de ${expected} updates`);
        }

        return now;
      },
      { timeout: 30_000, interval: 500 },
    );

    const all = after.all - before.all;
    const hot = after.hot - before.hot;

    expect(all).toBeGreaterThanOrEqual(expected);
    expect(hot / all, `${hot} de ${all} HOT`).toBeGreaterThan(0.9);
  }, 120_000);

  it("still reads a company's drivers down its index, never the whole table", async () => {
    const plan = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off");

      return tx.$queryRawUnsafe<Array<{ "QUERY PLAN": string }>>(`
        EXPLAIN
        SELECT p."driverId", p."recorded_at"
        FROM "driver_last_position" p
        WHERE p."businessId" = '${CARRIER}'
          AND p."recorded_at" >= now() - interval '1 hour'
        ORDER BY p."recorded_at" DESC
      `);
    });

    const text = plan.map((row) => row["QUERY PLAN"]).join("\n");

    expect(text).toContain("driver_last_position_businessId_idx");
    expect(text).not.toMatch(/Seq Scan on driver_last_position/);
  });
});
