import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient, type DeliveryStatus } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { DeliveryRepository } from "@/modules/delivery/repositories/delivery-repository";

/**
 * The board's counts read the company's history ONCE in the default view.
 *
 * The listing counts deliveries per status, per shipper and per driver, each
 * without its own filter. With no facet and no search the three `where`s are
 * the same (the whole tenant), and the repository ran three grouped reads of
 * it: under the load harness, on a tenant with 300k deliveries, those were
 * 64 + 64 + 28 ms per page view and a third of the database CPU at 120 req/s
 * (docs/desempenho/carga-2026-10.md). One GROUPING SETS read answers all
 * three; with a facet chosen the reads differ and stay separate.
 *
 * Counted on a logging client handed to the real repository, against the
 * real database; the expected numbers come from independent groupBys.
 */
const counted = new PrismaClient({ log: [{ level: "query", emit: "event" }] });
const prisma = new PrismaClient();

const statements: string[] = [];

const CARRIER = "018fe600-0000-7000-8000-00000000000a";
const OTHER = "018fe600-0000-7000-8000-00000000000b";

const STATUSES: DeliveryStatus[] = [
  "PENDING",
  "IN_TRANSIT",
  "DELIVERED",
  "FAILED",
];

let shipperIds: string[] = [];
let driverIds: string[] = [];

async function seedTenant(
  businessId: string,
  label: string,
  perDriver: number[],
) {
  await prisma.business.create({
    data: {
      id: businessId,
      corporate_reason: `Transportadora ${label}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(73000000000000 + Math.floor(Math.random() * 9_000_000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `facetas-${randomUUID()}@exemplo.com.br`,
    },
  });

  const shippers = await Promise.all(
    ["Embarcador A", "Embarcador B"].map((name) =>
      prisma.shipper.create({ data: { name: `${name} ${label}`, businessId } }),
    ),
  );

  const drivers = await Promise.all(
    perDriver.map((_, n) =>
      prisma.driver.create({
        data: {
          name: `Motorista ${label} ${n}`,
          birth_date: new Date("1990-01-01"),
          cnh: randomUUID().slice(0, 11),
          cpf: randomUUID().slice(0, 14),
          rg: randomUUID().slice(0, 12),
          cep: "01001000",
          city: "São Paulo",
          uf: "SP",
          street: "Rua",
          address_number: "1",
          status: "ACTIVE",
          contract_type: "OWNED",
          businessId,
        },
      }),
    ),
  );

  // Uneven on purpose: each driver its own volume, statuses and shippers
  // interleaved, and unassigned deliveries (driverId NULL) as a facet value.
  const rows = perDriver.flatMap((count, n) =>
    Array.from({ length: count }, (_, i) => ({
      recipient_name: `Cliente ${label} ${n}-${i}`,
      code: `FAC-${label}-${n}-${i}`,
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      businessId,
      shipperId: shippers[(n + i) % 2].id,
      driverId: n === perDriver.length - 1 ? null : drivers[n].id,
      status: STATUSES[(n * 3 + i) % STATUSES.length],
    })),
  );

  await prisma.delivery.createMany({ data: rows });

  return {
    shippers: shippers.map((s) => s.id),
    drivers: drivers.map((d) => d.id),
  };
}

/** Grouped reads over delivery, as the logging client saw them. */
function groupedReads(): string[] {
  return statements.filter(
    (sql) => /FROM "public"\."delivery"/.test(sql) && /GROUP BY/i.test(sql),
  );
}

async function expectedCounts(where: {
  businessId: string;
  driverId?: string;
  status?: { in: DeliveryStatus[] };
}) {
  const { status, ...withoutStatus } = where;

  const byStatus = await prisma.delivery.groupBy({
    by: ["status"],
    where: withoutStatus,
    _count: { _all: true },
  });
  const byShipper = await prisma.delivery.groupBy({
    by: ["shipperId"],
    where,
    _count: { _all: true },
  });
  const byDriver = await prisma.delivery.groupBy({
    by: ["driverId"],
    where,
    _count: { _all: true },
  });

  void status;

  return {
    status: Object.fromEntries(byStatus.map((g) => [g.status, g._count._all])),
    shipper: Object.fromEntries(
      byShipper.map((g) => [g.shipperId, g._count._all]),
    ),
    driver: Object.fromEntries(
      byDriver.map((g) => [g.driverId ?? "null", g._count._all]),
    ),
  };
}

function actualCounts(
  page: Awaited<ReturnType<DeliveryRepository["listDeliveries"]>>,
) {
  return {
    status: Object.fromEntries(
      page.statusCounts
        .filter((g) => g.count > 0)
        .map((g) => [g.value, g.count]),
    ),
    shipper: Object.fromEntries(
      page.shipperOptions
        .filter((o) => o.count > 0)
        .map((o) => [o.value, o.count]),
    ),
    driver: Object.fromEntries(
      page.driverOptions
        .filter((o) => o.count > 0)
        .map((o) => [o.value, o.count]),
    ),
  };
}

const repository = new DeliveryRepository(counted as never);

beforeAll(async () => {
  counted.$on("query" as never, (event: { query: string }) => {
    statements.push(event.query);
  });

  const carrier = await seedTenant(CARRIER, "Facetas", [7, 3, 5, 4]);

  shipperIds = carrier.shippers;
  driverIds = carrier.drivers;

  // A neighbour with more rows than the carrier: none may leak into its counts.
  await seedTenant(OTHER, "Vizinha", [11, 9, 6]);
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
  await counted.$disconnect();
});

describe("the delivery board's counts", () => {
  it("default view: one grouped read, the same numbers as three", async () => {
    statements.length = 0;

    const page = await repository.listDeliveries({
      businessId: CARRIER,
      page: 1,
      pageSize: 5,
    });

    expect(groupedReads()).toHaveLength(1);
    expect(groupedReads()[0]).toMatch(/GROUPING SETS/i);

    expect(page.data).toHaveLength(5);

    const expected = await expectedCounts({ businessId: CARRIER });
    const actual = actualCounts(page);

    expect(actual.status).toEqual(expected.status);
    expect(actual.shipper).toEqual(expected.shipper);

    // The unassigned group (driverId NULL, 4 rows) is counted by the driver
    // set and, having no driver to name, offers no option — as before.
    expect(expected.driver.null).toBe(4);
    expect(
      page.driverOptions.map((option) => [option.value, option.count]).sort(),
    ).toEqual(
      driverIds
        .slice(0, 3)
        .map((driverId) => [driverId, expected.driver[driverId]])
        .sort(),
    );

    // Labels come from the company's own catalog.
    expect(page.shipperOptions.map((option) => option.label).sort()).toEqual([
      "Embarcador A Facetas",
      "Embarcador B Facetas",
    ]);
  });

  it("a driver's own scope is still one read, counted only over their rows", async () => {
    statements.length = 0;

    const page = await repository.listDeliveries({
      businessId: CARRIER,
      scopeDriverId: driverIds[0],
      page: 1,
      pageSize: 50,
    });

    expect(groupedReads()).toHaveLength(1);

    const expected = await expectedCounts({
      businessId: CARRIER,
      driverId: driverIds[0],
    });
    const actual = actualCounts(page);

    expect(page.data).toHaveLength(7);
    expect(actual.status).toEqual(expected.status);
    expect(actual.shipper).toEqual(expected.shipper);
    expect(
      page.driverOptions
        .filter((o) => o.count > 0)
        .map((o) => [o.value, o.count]),
    ).toEqual([[driverIds[0], 7]]);
  });

  it("with a facet chosen, each count still ignores only its own facet", async () => {
    statements.length = 0;

    const statuses: DeliveryStatus[] = ["DELIVERED"];
    const page = await repository.listDeliveries({
      businessId: CARRIER,
      statuses,
      page: 1,
      pageSize: 50,
    });

    // Different wheres: the status counts ignore the status filter, the
    // others apply it.
    expect(groupedReads()).toHaveLength(3);

    const expected = await expectedCounts({
      businessId: CARRIER,
      status: { in: statuses },
    });
    const actual = actualCounts(page);

    expect(actual.status).toEqual(expected.status);
    expect(actual.shipper).toEqual(expected.shipper);
    expect(page.data.every((delivery) => delivery.status === "DELIVERED")).toBe(
      true,
    );
  });

  it("a shipper filter keeps the shipper counts whole", async () => {
    const page = await repository.listDeliveries({
      businessId: CARRIER,
      shipperIds: [shipperIds[0]],
      page: 1,
      pageSize: 50,
    });

    const whole = await expectedCounts({ businessId: CARRIER });

    expect(actualCounts(page).shipper).toEqual(whole.shipper);
    expect(
      page.data.every((delivery) => delivery.shipperId === shipperIds[0]),
    ).toBe(true);
  });
});
