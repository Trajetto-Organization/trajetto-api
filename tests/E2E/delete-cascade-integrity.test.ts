import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";

import { randomUUID } from "node:crypto";

/**
 * What a hard delete takes with it.
 *
 * The delete use cases refuse a driver or a vehicle that still has fines,
 * fuel records, service orders or checklists — each with a named count, so the
 * operator knows what is in the way. Deliveries and routes were never on that
 * list, and the schema's referential actions make that omission silent rather
 * than loud: both relations are optional, so Postgres NULLs them instead of
 * refusing.
 *
 * The result is a driver who only ever made deliveries being deletable, and
 * every delivery they ever made losing who made it — with no error, no
 * warning, and nothing in the trail to reconstruct it from.
 *
 * These tests state what the database does, at the level where it does it.
 * They are the evidence behind the guards added above them; the ones that
 * assert a refusal exercise the use cases, and these exercise the floor those
 * use cases stand on.
 */
const prisma = new PrismaClient();

const CARRIER = "018f2000-0000-7000-8000-00000000000a";

const DRIVER = "018f2000-0000-7000-8000-0000000000d1";
const VEHICLE = "018f2000-0000-7000-8000-0000000000e1";
const SHIPPER = "018f2000-0000-7000-8000-0000000000f1";

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora Integridade",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: "11222333000199",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: "integridade@exemplo.com.br",
    },
  });

  await prisma.shipper.create({
    data: { id: SHIPPER, name: "Embarcador", businessId: CARRIER },
  });

  await prisma.driver.create({
    data: {
      id: DRIVER,
      name: "João",
      birth_date: new Date("1990-01-01"),
      cnh: "cnh-integridade",
      cpf: "cpf-integridade",
      rg: "rg-integridade",
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

  await prisma.fuelType.create({
    data: { id: "ft-integridade", description: "Diesel", businessId: CARRIER },
  });

  await prisma.vehicle.create({
    data: {
      id: VEHICLE,
      description: "Caminhão",
      license_plate: "III1I11",
      brand: "Volvo",
      model: "FH",
      acquisition_date: new Date(),
      fleet_type: "OWNED",
      current_mileage: 0,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: "renavam-integridade",
      manufacturing_year: new Date(),
      model_year: new Date(),
      km_per_liter: 3,
      number_of_axles: 3,
      status: "ACTIVE",
      businessId: CARRIER,
      fuelTypeId: "ft-integridade",
    },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function seedDelivery(overrides: Record<string, unknown> = {}) {
  const id = randomUUID();

  await prisma.delivery.create({
    data: {
      id,
      recipient_name: "Destinatário",
      city: "São Paulo",
      uf: "SP",
      street: "Rua das Entregas",
      businessId: CARRIER,
      shipperId: SHIPPER,
      ...overrides,
    },
  });

  return id;
}

describe("the referential actions behind a driver", () => {
  it("nulls the driver on every delivery they ever made", async () => {
    // `Delivery.driver` is an optional relation with no explicit onDelete, so
    // Prisma's default is SetNull. That is the right default for a column that
    // means "assigned to"; it is the wrong outcome for one that also means
    // "was delivered by", which is what it becomes the moment the delivery is
    // proven.
    const proven = await seedDelivery({
      driverId: DRIVER,
      status: "DELIVERED",
      delivered_at: new Date(),
    });

    const scratchDriver = await prisma.driver.create({
      data: {
        name: "Motorista descartável",
        birth_date: new Date("1990-01-01"),
        cnh: `cnh-${randomUUID()}`,
        cpf: `cpf-${randomUUID()}`,
        rg: `rg-${randomUUID()}`,
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

    const theirDelivery = await seedDelivery({
      driverId: scratchDriver.id,
      status: "DELIVERED",
      delivered_at: new Date(),
    });

    await prisma.driver.delete({ where: { id: scratchDriver.id } });

    const orphaned = await prisma.delivery.findUniqueOrThrow({
      where: { id: theirDelivery },
    });

    // Delivered, with a delivered_at, and nobody delivered it. No error was
    // raised and nothing recorded that this happened.
    expect(orphaned.status).toBe("DELIVERED");
    expect(orphaned.driverId).toBeNull();

    // The other driver's history is untouched, which is the only reassuring
    // part: the damage is scoped to the driver removed.
    expect(
      (await prisma.delivery.findUniqueOrThrow({ where: { id: proven } }))
        .driverId,
    ).toBe(DRIVER);
  });

  it("refuses outright when the driver has a route", async () => {
    // `Route.driver` is REQUIRED, so the default action is Restrict and
    // Postgres blocks the delete. Safer than the delivery case — the data
    // survives — but it surfaces as a foreign-key error, which a use case
    // with no guard turns into a 500.
    const scratchDriver = await prisma.driver.create({
      data: {
        name: "Motorista com rota",
        birth_date: new Date("1990-01-01"),
        cnh: `cnh-${randomUUID()}`,
        cpf: `cpf-${randomUUID()}`,
        rg: `rg-${randomUUID()}`,
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

    await prisma.route.create({
      data: {
        code: 900,
        scheduled_date: new Date(),
        businessId: CARRIER,
        driverId: scratchDriver.id,
      },
    });

    await expect(
      prisma.driver.delete({ where: { id: scratchDriver.id } }),
    ).rejects.toThrow();
  });
});

describe("the referential actions behind a vehicle", () => {
  it("nulls the vehicle on the routes it ran", async () => {
    // `Route.vehicle` is optional — a route is planned before a truck is
    // chosen — so the default is SetNull here too. On a COMPLETED route that
    // erases which vehicle did the work.
    const scratchVehicle = await prisma.vehicle.create({
      data: {
        description: "Caminhão descartável",
        license_plate: `X${randomUUID().slice(0, 6)}`,
        brand: "Volvo",
        model: "FH",
        acquisition_date: new Date(),
        fleet_type: "OWNED",
        current_mileage: 0,
        maintenance_interval_km: 10000,
        maintenance_interval_months: 6,
        renavam: randomUUID(),
        manufacturing_year: new Date(),
        model_year: new Date(),
        km_per_liter: 3,
        number_of_axles: 3,
        status: "ACTIVE",
        businessId: CARRIER,
        fuelTypeId: "ft-integridade",
      },
    });

    const route = await prisma.route.create({
      data: {
        code: 901,
        scheduled_date: new Date(),
        status: "COMPLETED",
        completed_at: new Date(),
        businessId: CARRIER,
        driverId: DRIVER,
        vehicleId: scratchVehicle.id,
      },
    });

    await prisma.vehicle.delete({ where: { id: scratchVehicle.id } });

    const orphaned = await prisma.route.findUniqueOrThrow({
      where: { id: route.id },
    });

    expect(orphaned.status).toBe("COMPLETED");
    expect(orphaned.vehicleId).toBeNull();
  });
});

describe("what a company taking its data with it does take", () => {
  it("removes its routes and their stops, and nothing of anyone else", async () => {
    // Business is Cascade everywhere on purpose: a company leaving takes its
    // own data. What matters is that the blast radius stops at the tenant.
    const otherCarrier = await prisma.business.create({
      data: {
        corporate_reason: "Transportadora Vizinha",
        cep: "01001000",
        city: "São Paulo",
        uf: "SP",
        street: "Rua",
        address_number: "1",
        cnpj: `1122233300${randomUUID().slice(0, 4)}`.slice(0, 14),
        cnae: "4930202",
        responsible_name: "Responsável",
        telephone: "11999999999",
        email: `vizinha-${randomUUID()}@exemplo.com.br`,
      },
    });

    const survivingRoute = await prisma.route.create({
      data: {
        code: 902,
        scheduled_date: new Date(),
        businessId: CARRIER,
        driverId: DRIVER,
      },
    });

    await prisma.driver.create({
      data: {
        id: `drv-${otherCarrier.id}`,
        name: "Motorista vizinho",
        birth_date: new Date("1990-01-01"),
        cnh: `cnh-${randomUUID()}`,
        cpf: `cpf-${randomUUID()}`,
        rg: `rg-${randomUUID()}`,
        cep: "01001000",
        city: "São Paulo",
        uf: "SP",
        street: "Rua",
        address_number: "1",
        status: "ACTIVE",
        contract_type: "OWNED",
        businessId: otherCarrier.id,
      },
    });

    const doomedRoute = await prisma.route.create({
      data: {
        code: 1,
        scheduled_date: new Date(),
        businessId: otherCarrier.id,
        driverId: `drv-${otherCarrier.id}`,
      },
    });

    await prisma.business.delete({ where: { id: otherCarrier.id } });

    expect(
      await prisma.route.findUnique({ where: { id: doomedRoute.id } }),
    ).toBeNull();

    expect(
      await prisma.route.findUnique({ where: { id: survivingRoute.id } }),
    ).not.toBeNull();
  });
});
