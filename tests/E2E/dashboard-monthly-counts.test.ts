import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { DashboardRepository } from "@/modules/dashboard/repositories/dashboard-repository";
import {
  businessMonthStart,
  zonedWallTimeToUtc,
} from "@/shared/time/business-day";

/**
 * The dashboard's numbers, grouped in the database instead of counted one
 * month at a time — and grouped by the COMPANY's months.
 *
 * `created_at` holds a UTC instant in a `timestamp WITHOUT time zone` column.
 * The months the cards and the trend speak of are the carrier's civil months
 * in `Business.timezone`. They used to be the server process's months: UTC in
 * the container (a row created at 22:00 on the 31st in São Paulo landed in the
 * next month) and São Paulo on a developer machine (so no test caught it).
 * Every assertion below names its zone and uses instants that fall in
 * different months in different zones.
 */
const prisma = new PrismaClient();

const CARRIER = "018fa000-0000-7000-8000-00000000000a";
const OTHER = "018fa000-0000-7000-8000-00000000000b";

const SP = "America/Sao_Paulo"; // UTC-3
const MANAUS = "America/Manaus"; // UTC-4

const repository = new DashboardRepository();

async function seedBusiness(id: string, cnpj: string): Promise<void> {
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

async function seedSupplier(businessId: string, createdAt: Date): Promise<void> {
  await prisma.supplier.create({
    data: {
      name: `Fornecedor ${randomUUID().slice(0, 8)}`,
      cnpj: String(30000000000000 + Math.floor(Math.random() * 9000000)),
      businessId,
      created_at: createdAt,
    },
  });
}

/** [start of `from` month, start of the month after `to`) in the zone. */
function months(zone: string, from: string, toExclusive: string) {
  return {
    from: businessMonthStart(from, zone),
    to: businessMonthStart(toExclusive, zone),
    timeZone: zone,
  };
}

beforeAll(async () => {
  await seedBusiness(CARRIER, "44222888000101");
  await seedBusiness(OTHER, "44222888000102");
}, 90_000);

afterAll(async () => {
  await prisma.supplier.deleteMany({
    where: { businessId: { in: [CARRIER, OTHER] } },
  });

  await prisma.business.deleteMany({ where: { id: { in: [CARRIER, OTHER] } } });

  await prisma.$disconnect();
});

describe("counting a month in the database", () => {
  it("agrees with counting each company month on its own", async () => {
    const plan = [
      { month: "2026-03", rows: 3 },
      { month: "2026-04", rows: 5 },
      { month: "2026-05", rows: 2 },
    ];

    for (const entry of plan) {
      const [year, month] = entry.month.split("-").map(Number);

      for (let n = 0; n < entry.rows; n += 1) {
        await seedSupplier(CARRIER, zonedWallTimeToUtc(SP, year, month, 10, 12));
      }
    }

    const grouped = await repository.countByMonth(
      { entity: "supplier", ...months(SP, "2026-03", "2026-06") },
      CARRIER,
    );

    const found = new Map(grouped.map((bucket) => [bucket.month, bucket.count]));

    for (const entry of plan) {
      // The reference answer, asked directly on the company's month bounds.
      const [year, month] = entry.month.split("-").map(Number);
      const reference = await prisma.supplier.count({
        where: {
          businessId: CARRIER,
          created_at: {
            gte: zonedWallTimeToUtc(SP, year, month, 1),
            lt: zonedWallTimeToUtc(SP, year, month + 1, 1),
          },
        },
      });

      expect(found.get(entry.month), entry.month).toBe(entry.rows);
      expect(found.get(entry.month), `${entry.month} vs count`).toBe(reference);
    }
  });

  it("files 22:00 of the 31st under the company's month, not UTC's", async () => {
    // 22:00 on 31 May in São Paulo is 01:00 UTC on 1 June.
    await seedSupplier(CARRIER, zonedWallTimeToUtc(SP, 2025, 5, 31, 22));

    const inSaoPaulo = await repository.countByMonth(
      { entity: "supplier", ...months(SP, "2025-05", "2025-07") },
      CARRIER,
    );

    expect(inSaoPaulo).toEqual([{ month: "2025-05", count: 1 }]);

    // The same row in a UTC calendar is June: the zone is what decides.
    const inUtc = await repository.countByMonth(
      { entity: "supplier", ...months("UTC", "2025-05", "2025-07") },
      CARRIER,
    );

    expect(inUtc).toEqual([{ month: "2025-06", count: 1 }]);
  });

  it("follows the company's own zone, not a national one", async () => {
    // 23:30 on 31 Aug in Manaus is 00:30 on 1 Sep in São Paulo.
    await seedSupplier(CARRIER, zonedWallTimeToUtc(MANAUS, 2025, 8, 31, 23, 30));

    const inManaus = await repository.countByMonth(
      { entity: "supplier", ...months(MANAUS, "2025-08", "2025-10") },
      CARRIER,
    );

    const inSaoPaulo = await repository.countByMonth(
      { entity: "supplier", ...months(SP, "2025-08", "2025-10") },
      CARRIER,
    );

    expect(inManaus).toEqual([{ month: "2025-08", count: 1 }]);
    expect(inSaoPaulo).toEqual([{ month: "2025-09", count: 1 }]);
  });

  it("includes the window's first instant and excludes its end", async () => {
    const start = zonedWallTimeToUtc(SP, 2025, 1, 1);
    const end = zonedWallTimeToUtc(SP, 2025, 2, 1);

    await seedSupplier(CARRIER, start);
    await seedSupplier(CARRIER, end);

    const grouped = await repository.countByMonth(
      { entity: "supplier", from: start, to: end, timeZone: SP },
      CARRIER,
    );

    expect(grouped).toEqual([{ month: "2025-01", count: 1 }]);
  });

  it("never counts another company's rows", async () => {
    await seedSupplier(OTHER, zonedWallTimeToUtc(SP, 2024, 2, 15, 12));

    const grouped = await repository.countByMonth(
      { entity: "supplier", ...months(SP, "2024-02", "2024-03") },
      CARRIER,
    );

    expect(grouped).toEqual([]);
  });

  it("returns nothing rather than zeros for an empty window", async () => {
    // The use case fills the gaps, which is where "a month with no rows shows
    // a zero" belongs.
    const grouped = await repository.countByMonth(
      { entity: "supplier", ...months(SP, "2019-01", "2020-01") },
      CARRIER,
    );

    expect(grouped).toEqual([]);
  });

  it("refuses an entity that is not in the map", async () => {
    await expect(
      repository.countByMonth(
        {
          entity: "inventado" as never,
          from: new Date(),
          to: new Date(),
          timeZone: SP,
        },
        CARRIER,
      ),
    ).rejects.toThrow("Entidade inválida");
  });
});

describe("every entity in one round trip", () => {
  it("returns the same numbers as asking each on its own", async () => {
    for (let n = 0; n < 4; n += 1) {
      await seedSupplier(CARRIER, zonedWallTimeToUtc(SP, 2023, 7, 5, 12));
    }

    const window = months(SP, "2023-07", "2023-08");

    const one = await repository.countByMonth(
      { entity: "supplier", ...window },
      CARRIER,
    );
    const many = await repository.countManyByMonth(
      { entities: ["supplier", "driver", "vehicle"], ...window },
      CARRIER,
    );

    // The whole reason the stitched query is allowed to exist.
    expect(many.supplier).toEqual(one);
    expect(one).toEqual([{ month: "2023-07", count: 4 }]);
  });

  it("answers for every entity asked, empty ones included", async () => {
    const many = await repository.countManyByMonth(
      {
        entities: ["supplier", "driver", "vehicle", "fine"],
        ...months(SP, "2018-01", "2019-01"),
      },
      CARRIER,
    );

    expect(Object.keys(many).sort()).toEqual([
      "driver",
      "fine",
      "supplier",
      "vehicle",
    ]);

    expect(many.driver).toEqual([]);
  });

  it("keeps each entity's rows under its own name", async () => {
    await seedSupplier(CARRIER, zonedWallTimeToUtc(SP, 2022, 4, 10, 12));

    const many = await repository.countManyByMonth(
      { entities: ["supplier", "driver"], ...months(SP, "2022-04", "2022-05") },
      CARRIER,
    );

    expect(many.supplier).toEqual([{ month: "2022-04", count: 1 }]);
    expect(many.driver).toEqual([]);
  });

  it("answers nothing for an empty list of entities", async () => {
    const many = await repository.countManyByMonth(
      { entities: [], from: new Date(), to: new Date(), timeZone: SP },
      CARRIER,
    );

    expect(many).toEqual({});
  });

  it("ignores an entity that is not in the map instead of failing the page", async () => {
    const many = await repository.countManyByMonth(
      {
        entities: ["supplier", "inventado" as never],
        ...months(SP, "2018-01", "2019-01"),
      },
      CARRIER,
    );

    expect(many.inventado).toEqual([]);
    expect(many.supplier).toEqual([]);
  });
});

describe("the daily cut", () => {
  it("files the night under the company's day", async () => {
    // 22:30 on 14 Mar 2021 in São Paulo: already the 15th in UTC.
    await seedSupplier(CARRIER, zonedWallTimeToUtc(SP, 2021, 3, 14, 22, 30));

    const days = await repository.countManyByPeriod(
      {
        entities: ["supplier"],
        from: zonedWallTimeToUtc(SP, 2021, 3, 14),
        to: zonedWallTimeToUtc(SP, 2021, 3, 16),
        granularity: "day",
        timeZone: SP,
      },
      CARRIER,
    );

    expect(days.supplier).toEqual([{ period: "2021-03-14", count: 1 }]);
  });
});

/**
 * The overview's catalogue cards are stocks (count-comparison): the total
 * now, and the total when the company's month began. They used to show only
 * what was created this month, so twenty drivers registered last year read 0.
 */
describe("the catalogue totals", () => {
  const STOCK = "018fa000-0000-7000-8000-00000000000c";

  beforeAll(async () => {
    await seedBusiness(STOCK, "44222888000103");

    // Two before 01/10 in São Paulo (one at 23:30 of 30/09, already October
    // in UTC) and one after.
    await seedSupplier(STOCK, zonedWallTimeToUtc(SP, 2025, 6, 10, 9, 0));
    await seedSupplier(STOCK, zonedWallTimeToUtc(SP, 2026, 9, 30, 23, 30));
    await seedSupplier(STOCK, zonedWallTimeToUtc(SP, 2026, 10, 2, 8, 0));
    await seedSupplier(OTHER, zonedWallTimeToUtc(SP, 2026, 10, 2, 8, 0));
  });

  afterAll(async () => {
    await prisma.supplier.deleteMany({ where: { businessId: STOCK } });
    await prisma.business.delete({ where: { id: STOCK } });
  });

  it("counts every row and those created before the company's month began", async () => {
    const totals = await repository.countManyTotals(
      { entities: ["supplier", "vehicle"], before: businessMonthStart("2026-10", SP) },
      STOCK,
    );

    expect(totals.supplier).toEqual({ total: 3, before: 2 });
    expect(totals.vehicle).toEqual({ total: 0, before: 0 });
  });

  it("cuts by the company's zone: 23:30 of 30/09 in São Paulo is still September", async () => {
    const inManaus = await repository.countManyTotals(
      { entities: ["supplier"], before: businessMonthStart("2026-10", MANAUS) },
      STOCK,
    );

    // 01/10 00:00 in Manaus is 04:00 UTC: the 23:30 row (02:30 UTC) is before it too.
    expect(inManaus.supplier).toEqual({ total: 3, before: 2 });

    const atUtcMidnight = await repository.countManyTotals(
      { entities: ["supplier"], before: new Date("2026-10-01T00:00:00.000Z") },
      STOCK,
    );

    // A UTC cut would have left that row out.
    expect(atUtcMidnight.supplier).toEqual({ total: 3, before: 1 });
  });

  it("never counts another company's rows, and answers zeros for an unknown entity", async () => {
    const totals = await repository.countManyTotals(
      { entities: ["supplier", "inventado" as never], before: businessMonthStart("2026-10", SP) },
      STOCK,
    );

    expect(totals.supplier.total).toBe(3);
    expect(totals.inventado).toEqual({ total: 0, before: 0 });
    expect(await repository.countManyTotals({ entities: [], before: new Date() }, STOCK)).toEqual({});
  });
});
