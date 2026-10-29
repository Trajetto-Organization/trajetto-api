import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import { ImportRepository } from "@/modules/import/repositories/import-repository";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * The undo, against the database that actually performs it.
 *
 * The unit suite proves the same rules against a fake, and that fake is a
 * mirror — a mirror is worth exactly what the hand that cut it was worth. Here
 * the real transaction runs: the counts of events and occurrences come out of
 * Postgres, the deletes hit real foreign keys, and the order of operations
 * (routes before deliveries, because a stop references its delivery) is the
 * one thing a fake with arrays cannot exercise at all.
 */
const prisma = createPrismaClient();
const imports = new ImportRepository(prisma);

const CARRIER = "018f4000-0000-7000-8000-00000000000a";
const OTHER = "018f4000-0000-7000-8000-00000000000b";

const DISPATCHER = "018f4000-0000-7000-8000-0000000000a1";
const DRIVER = "018f4000-0000-7000-8000-0000000000d1";
const SHIPPER = "018f4000-0000-7000-8000-0000000000f1";

async function seedCarrier(id: string, cnpj: string) {
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

beforeAll(async () => {
  await seedCarrier(CARRIER, "11222333000166");
  await seedCarrier(OTHER, "11222333000155");

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

  await prisma.driver.create({
    data: {
      id: DRIVER,
      name: "João",
      birth_date: new Date("1990-01-01"),
      cnh: "cnh-estorno",
      cpf: "cpf-estorno",
      rg: "rg-estorno",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId: CARRIER,
    },
  });

  await prisma.shipper.create({
    data: { id: SHIPPER, name: "Embarcador", businessId: CARRIER },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

let routeCode = 0;

async function seedImport() {
  return prisma.import.create({
    data: {
      source: "SPREADSHEET",
      filename: "entregas.xlsx",
      report: {},
      businessId: CARRIER,
      performedById: DISPATCHER,
    },
  });
}

async function seedDelivery(
  importId: string,
  overrides: Record<string, unknown> = {},
) {
  return prisma.delivery.create({
    data: {
      recipient_name: `Cliente ${randomUUID().slice(0, 6)}`,
      city: "São Paulo",
      uf: "SP",
      street: "Rua das Entregas",
      businessId: CARRIER,
      shipperId: SHIPPER,
      importId,
      ...overrides,
    },
  });
}

async function seedRoute(
  importId: string,
  deliveryIds: string[],
  overrides: Record<string, unknown> = {},
) {
  routeCode += 1;

  return prisma.route.create({
    data: {
      code: routeCode,
      scheduled_date: new Date(),
      businessId: CARRIER,
      driverId: DRIVER,
      importId,
      stops: {
        create: deliveryIds.map((deliveryId, index) => ({
          deliveryId,
          sequence: (index + 1) * 10,
        })),
      },
      ...overrides,
    },
  });
}

describe("undoing an upload nobody touched", () => {
  it("removes the deliveries, the route and its stops", async () => {
    const record = await seedImport();

    const first = await seedDelivery(record.id);
    const second = await seedDelivery(record.id);

    const route = await seedRoute(record.id, [first.id, second.id]);

    const result = await imports.reverseImport(record.id, CARRIER);

    expect(result).toMatchObject({ removedDeliveries: 2, removedRoutes: 1 });

    expect(
      await prisma.delivery.findUnique({ where: { id: first.id } }),
    ).toBeNull();
    expect(
      await prisma.route.findUnique({ where: { id: route.id } }),
    ).toBeNull();

    // The stops went with the route — a stop with no route is a row nothing
    // can ever reach.
    expect(await prisma.routeStop.count({ where: { routeId: route.id } })).toBe(
      0,
    );
  });

  it("deletes the route before its deliveries, which is the only order that works", async () => {
    // A stop references its delivery. Deleting the delivery first is a foreign
    // key violation, and the whole transaction would roll back — the undo
    // would simply never work, and only against a real database would anyone
    // find out.
    const record = await seedImport();

    const delivery = await seedDelivery(record.id);
    await seedRoute(record.id, [delivery.id]);

    await expect(
      imports.reverseImport(record.id, CARRIER),
    ).resolves.toMatchObject({ removedDeliveries: 1, removedRoutes: 1 });
  });

  it("marks the upload reversed", async () => {
    const record = await seedImport();

    await seedDelivery(record.id);
    await imports.reverseImport(record.id, CARRIER);

    const after = await prisma.import.findUniqueOrThrow({
      where: { id: record.id },
    });

    expect(after.status).toBe("REVERSED");
    expect(after.reversed_at).not.toBeNull();
  });
});

describe("the line the undo does not cross", () => {
  it("keeps a delivery that already left", async () => {
    const record = await seedImport();

    const untouched = await seedDelivery(record.id);
    const moving = await seedDelivery(record.id, { status: "IN_TRANSIT" });

    const result = await imports.reverseImport(record.id, CARRIER);

    expect(result.removedDeliveries).toBe(1);
    expect(result.keptDeliveries.map((entry) => entry.id)).toEqual([moving.id]);

    expect(
      await prisma.delivery.findUnique({ where: { id: moving.id } }),
    ).not.toBeNull();

    expect(
      await prisma.delivery.findUnique({ where: { id: untouched.id } }),
    ).toBeNull();
  });

  it("keeps a delivery the driver reported on, even though it is still pending", async () => {
    // The status is not the only evidence that somebody worked it. This is the
    // count the fake can only simulate.
    const record = await seedImport();

    const delivery = await seedDelivery(record.id);

    await prisma.deliveryEvent.create({
      data: {
        type: "ARRIVAL",
        deliveryId: delivery.id,
        businessId: CARRIER,
        reportedById: DISPATCHER,
        client_submission_id: randomUUID(),
      },
    });

    const result = await imports.reverseImport(record.id, CARRIER);

    expect(result.removedDeliveries).toBe(0);
    expect(result.keptDeliveries[0].reason).toContain("registros do motorista");
  });

  it("keeps a route that would be left with holes in it", async () => {
    const record = await seedImport();

    const removable = await seedDelivery(record.id);
    const worked = await seedDelivery(record.id, { status: "DELIVERED" });

    const route = await seedRoute(record.id, [removable.id, worked.id]);

    const result = await imports.reverseImport(record.id, CARRIER);

    expect(result.removedRoutes).toBe(0);
    expect(result.keptRoutes[0].reason).toContain("não puderam ser removidas");

    // And the deliveries that would have left holes are still there, because
    // their stops still point at them.
    expect(
      await prisma.route.findUnique({ where: { id: route.id } }),
    ).not.toBeNull();
  });

  it("cuts what survived loose from the upload", async () => {
    const record = await seedImport();

    const worked = await seedDelivery(record.id, { status: "DELIVERED" });

    await imports.reverseImport(record.id, CARRIER);

    const after = await prisma.delivery.findUniqueOrThrow({
      where: { id: worked.id },
    });

    expect(after.importId).toBeNull();
  });
});

describe("the tenant boundary of an undo", () => {
  it("does not reach an upload of another carrier", async () => {
    const record = await seedImport();
    const delivery = await seedDelivery(record.id);

    const result = await imports.reverseImport(record.id, OTHER);

    expect(result).toMatchObject({ removedDeliveries: 0, removedRoutes: 0 });

    expect(
      await prisma.delivery.findUnique({ where: { id: delivery.id } }),
    ).not.toBeNull();

    // And the upload is still open, because the `where` matched nothing.
    expect(
      (await prisma.import.findUniqueOrThrow({ where: { id: record.id } }))
        .status,
    ).toBe("COMPLETED");
  });
});
