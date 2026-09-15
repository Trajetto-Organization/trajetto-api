import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { DashboardRepository } from "@/modules/dashboard/repositories/dashboard-repository";

/**
 * The dashboard's numbers, grouped in the database instead of counted one
 * month at a time.
 *
 * The old code asked nine entities × eight months = 72 separate counts for one
 * page view (89 queries measured, including auth). The replacement asks nine.
 * The ONLY thing that makes that a safe trade is that it produces identical
 * numbers, and identical is not something a unit test can establish here: the
 * grouping happens in SQL, against a `timestamp WITHOUT time zone` column, in
 * a session whose timezone is not the server's.
 *
 * That last part is the trap. `created_at` holds a UTC instant; the database
 * session runs in UTC; the cards were always computed from LOCAL month
 * boundaries. A plain `date_trunc` would therefore file everything created
 * between 21:00 and midnight on the last day of a Brazilian month under the
 * next month — a card wrong by a day at the start of every month, which is
 * exactly when somebody looks at it.
 */
const prisma = new PrismaClient();

const CARRIER = "018fa000-0000-7000-8000-00000000000a";
const OTHER = "018fa000-0000-7000-8000-00000000000b";

const repository = new DashboardRepository();

/** A local wall-clock moment, as the naive UTC instant the column stores. */
function localMoment(
  year: number,
  monthIndex: number,
  day: number,
  hour: number,
): Date {
  return new Date(year, monthIndex, day, hour, 0, 0, 0);
}

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

/** The month a local Date belongs to, as the API reports it. */
const monthKey = (at: Date): string =>
  `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}`;

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
  it("agrees with counting it one month at a time", async () => {
    const year = 2026;

    // Three months, different counts, so a grouping that collapsed them or
    // shifted them by one would show.
    const plan = [
      { monthIndex: 2, rows: 3 },
      { monthIndex: 3, rows: 5 },
      { monthIndex: 4, rows: 2 },
    ];

    for (const entry of plan) {
      for (let n = 0; n < entry.rows; n += 1) {
        await seedSupplier(CARRIER, localMoment(year, entry.monthIndex, 10, 12));
      }
    }

    const from = localMoment(year, 2, 1, 0);
    const to = new Date(year, 5, 0, 23, 59, 59, 999);

    const grouped = await repository.countByMonth(
      { entity: "supplier", from, to },
      CARRIER,
    );

    const found = new Map(
      grouped.map((bucket) => [bucket.month, bucket.count]),
    );

    for (const entry of plan) {
      const key = monthKey(new Date(year, entry.monthIndex, 1));

      // The old way, asked directly, as the reference answer.
      const reference = await repository.countByDateRange(
        {
          entity: "supplier",
          startDate: `${year}-${String(entry.monthIndex + 1).padStart(2, "0")}-01`,
          endDate: new Date(year, entry.monthIndex + 1, 0)
            .toISOString()
            .split("T")[0],
        },
        CARRIER,
      );

      expect(found.get(key), key).toBe(entry.rows);
      expect(found.get(key), `${key} vs countByDateRange`).toBe(reference.count);
    }
  });

  it("files a row created late on the last day under the month it was local", async () => {
    // 22:00 local on 31 May is 01:00 UTC on 1 June. Grouped in UTC it lands in
    // June; the cards say May, because they always did.
    const year = 2025;

    await seedSupplier(CARRIER, localMoment(year, 4, 31, 22));

    const grouped = await repository.countByMonth(
      {
        entity: "supplier",
        from: localMoment(year, 4, 1, 0),
        to: new Date(year, 5, 30, 23, 59, 59, 999),
      },
      CARRIER,
    );

    const found = new Map(
      grouped.map((bucket) => [bucket.month, bucket.count]),
    );

    expect(found.get(`${year}-05`)).toBe(1);
    expect(found.get(`${year}-06`) ?? 0).toBe(0);
  });

  it("files a row created just after midnight under the new month", async () => {
    // The other side of the same boundary, so the fix cannot be "always the
    // previous month".
    const year = 2025;

    await seedSupplier(CARRIER, localMoment(year, 7, 1, 1));

    const grouped = await repository.countByMonth(
      {
        entity: "supplier",
        from: localMoment(year, 6, 1, 0),
        to: new Date(year, 8, 0, 23, 59, 59, 999),
      },
      CARRIER,
    );

    const found = new Map(
      grouped.map((bucket) => [bucket.month, bucket.count]),
    );

    expect(found.get(`${year}-08`)).toBe(1);
    expect(found.get(`${year}-07`) ?? 0).toBe(0);
  });

  it("never counts another company's rows", async () => {
    const year = 2024;

    await seedSupplier(OTHER, localMoment(year, 1, 15, 12));

    const grouped = await repository.countByMonth(
      {
        entity: "supplier",
        from: localMoment(year, 1, 1, 0),
        to: new Date(year, 2, 0, 23, 59, 59, 999),
      },
      CARRIER,
    );

    expect(grouped).toEqual([]);
  });

  it("returns nothing rather than zeros for an empty window", async () => {
    // The use case fills the gaps, which is where "a month with no rows shows
    // a zero" belongs — the repository reporting invented rows would make it
    // impossible to tell an empty month from an unasked one.
    const grouped = await repository.countByMonth(
      {
        entity: "supplier",
        from: new Date(2019, 0, 1),
        to: new Date(2019, 11, 31),
      },
      CARRIER,
    );

    expect(grouped).toEqual([]);
  });

  it("refuses an entity that is not in the map", async () => {
    await expect(
      repository.countByMonth(
        { entity: "inventado" as never, from: new Date(), to: new Date() },
        CARRIER,
      ),
    ).rejects.toThrow("Entidade inválida");
  });
});

describe("every entity in one round trip", () => {
  it("returns the same numbers as asking each on its own", async () => {
    const year = 2023;

    for (let n = 0; n < 4; n += 1) {
      await seedSupplier(CARRIER, localMoment(year, 6, 5, 12));
    }

    const from = localMoment(year, 6, 1, 0);
    const to = new Date(year, 7, 0, 23, 59, 59, 999);

    const [one, many] = await Promise.all([
      repository.countByMonth({ entity: "supplier", from, to }, CARRIER),
      repository.countManyByMonth(
        { entities: ["supplier", "driver", "vehicle"], from, to },
        CARRIER,
      ),
    ]);

    // The whole reason the stitched query is allowed to exist.
    expect(many.supplier).toEqual(one);
  });

  it("answers for every entity asked, empty ones included", async () => {
    const many = await repository.countManyByMonth(
      {
        entities: ["supplier", "driver", "vehicle", "fine"],
        from: new Date(2018, 0, 1),
        to: new Date(2018, 11, 31),
      },
      CARRIER,
    );

    // A missing key renders as "undefined" where a number belongs, so an
    // entity with no rows has to come back as an empty list rather than be
    // absent.
    expect(Object.keys(many).sort()).toEqual([
      "driver",
      "fine",
      "supplier",
      "vehicle",
    ]);

    expect(many.driver).toEqual([]);
  });

  it("keeps each entity's rows under its own name", async () => {
    // The stitched query carries the entity as a literal column. Getting that
    // wrong would silently file every count under one name — and the screen
    // would show plausible numbers in the wrong cards.
    const year = 2022;

    await seedSupplier(CARRIER, localMoment(year, 3, 10, 12));

    const many = await repository.countManyByMonth(
      {
        entities: ["supplier", "driver"],
        from: localMoment(year, 3, 1, 0),
        to: new Date(year, 4, 0, 23, 59, 59, 999),
      },
      CARRIER,
    );

    expect(many.supplier).toEqual([{ month: `${year}-04`, count: 1 }]);
    expect(many.driver).toEqual([]);
  });

  it("answers nothing for an empty list of entities", async () => {
    const many = await repository.countManyByMonth(
      { entities: [], from: new Date(), to: new Date() },
      CARRIER,
    );

    expect(many).toEqual({});
  });

  it("ignores an entity that is not in the map instead of failing the page", async () => {
    // Unlike `countByMonth`, which throws: this one answers the whole
    // dashboard, and one bad name must not blank every card on it.
    const many = await repository.countManyByMonth(
      {
        entities: ["supplier", "inventado" as never],
        from: new Date(2018, 0, 1),
        to: new Date(2018, 11, 31),
      },
      CARRIER,
    );

    expect(many.inventado).toEqual([]);
    expect(many.supplier).toEqual([]);
  });
});
