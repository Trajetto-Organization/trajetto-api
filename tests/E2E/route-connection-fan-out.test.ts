import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

/**
 * How many pool connections the route screens take at the same time — the
 * budget of tests/E2E/connection-fan-out.test.ts (two: a page and its
 * count), applied to the reads this module owns.
 *
 * The assignment preview is asked on every driver, vehicle, day or selection
 * change of three dialogs (Planejar rota, Editar rota, Atribuir Motorista e
 * Veículo). It fired seven queries in one Promise.all, then two more: a few
 * dispatchers with the dialog open took the connections the drivers' proof
 * writes queue on.
 *
 * Measured by wrapping the application's own client, so the repositories and
 * use cases below run exactly the code production runs.
 */
const pool = vi.hoisted(() => ({ inFlight: 0, peak: 0, total: 0 }));

vi.mock("@/../infra/database", async () => {
  const { PrismaClient: Client } = await import("@prisma/client");

  const counted = new Client().$extends({
    query: {
      async $allOperations({ args, query }) {
        pool.inFlight += 1;
        pool.total += 1;
        pool.peak = Math.max(pool.peak, pool.inFlight);

        try {
          return await query(args);
        } finally {
          pool.inFlight -= 1;
        }
      },
    },
  });

  return { default: counted };
});

import database from "@/../infra/database";

import { RouteRepository } from "@/modules/route/repositories/route-repository";
import { UserRepository } from "@/modules/user/repositories/user-repository";

import { AssignmentPreviewUseCase } from "@/modules/route/usecases/assignment-preview/assignment-preview-usecase";
import { ListRoutesUseCase } from "@/modules/route/usecases/list-routes/list-routes-usecase";

const prisma = new PrismaClient();

const CARRIER = "018fdc00-0000-7000-8000-00000000000a";
const MANAGER = "018fdc00-0000-7000-8000-0000000000a1";
const DRIVER = "018fdc00-0000-7000-8000-0000000000d1";
const TRUCK = "018fdc00-0000-7000-8000-0000000000e1";
const SHIPPER = "018fdc00-0000-7000-8000-0000000000f1";

const DAY = new Date("2026-09-17T00:00:00.000Z");

const BUDGET = 2;

let deliveryOnReleased: string;

async function peakOf<T>(
  run: () => Promise<T>,
): Promise<{ peak: number; total: number; result: T }> {
  pool.inFlight = 0;
  pool.peak = 0;
  pool.total = 0;

  const result = await run();

  return { peak: pool.peak, total: pool.total, result };
}

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora da Prévia",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(72000000000000 + Math.floor(Math.random() * 9000000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `previa-${randomUUID()}@exemplo.com.br`,
    },
  });

  // FLEET too: its facts (open orders, last checklist) are the reads the
  // preview adds for a company that has it, the widest case to measure.
  await prisma.businessEntitlement.createMany({
    data: [
      { businessId: CARRIER, module: "DELIVERIES", enabled: true },
      { businessId: CARRIER, module: "FLEET", enabled: true },
    ],
  });

  await prisma.user.create({
    data: {
      id: MANAGER,
      name: "Despachante",
      email: `previa-${randomUUID()}@exemplo.com.br`,
      password: "nao-usado",
      role: "BUSINESS_ADMIN",
      businessId: CARRIER,
    },
  });

  await prisma.driver.create({
    data: {
      id: DRIVER,
      name: "Motorista da Prévia",
      birth_date: new Date("1990-01-01"),
      cnh: `CNH${randomUUID().slice(0, 8)}`,
      cpf: String(Date.now()).slice(-11),
      rg: randomUUID().slice(0, 9),
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

  const fuelType = await prisma.fuelType.create({
    data: { description: "Diesel", businessId: CARRIER },
  });

  await prisma.vehicle.create({
    data: {
      id: TRUCK,
      description: "Caminhão",
      license_plate: `PRV${Math.floor(Math.random() * 9000) + 1000}`,
      brand: "Volvo",
      model: "FH",
      acquisition_date: new Date(),
      fleet_type: "OWNED",
      current_mileage: 0,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: `renavam-previa-${randomUUID()}`,
      manufacturing_year: new Date(),
      model_year: new Date(),
      km_per_liter: 3,
      number_of_axles: 3,
      status: "ACTIVE",
      businessId: CARRIER,
      fuelTypeId: fuelType.id,
      driverId: DRIVER,
    },
  });

  const branch = await prisma.branch.create({
    data: {
      corporate_reason: "Filial da Prévia",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(73000000000000 + Math.floor(Math.random() * 9000000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `filial-previa-${randomUUID()}@exemplo.com.br`,
      businessId: CARRIER,
    },
  });

  for (const day of ["2026-09-10T12:00:00.000Z", "2026-09-12T12:00:00.000Z"]) {
    await prisma.serviceOrder.create({
      data: {
        date: new Date(day),
        maintenance_type: "INTERNAL",
        total_amount: 100,
        businessId: CARRIER,
        vehicleId: TRUCK,
        branchId: branch.id,
        responsibleUserId: MANAGER,
      },
    });
  }

  await prisma.vehicleChecklist.create({
    data: {
      checklist_date: new Date("2026-09-16T12:00:00.000Z"),
      current_mileage: 1000,
      tires_condition: "good",
      bumpers_condition: "good",
      windshield_condition: "good",
      mirrors_condition: "good",
      steering_wheel_condition: "good",
      battery_condition: "good",
      spare_tire_condition: "good",
      overall_condition: "rejected",
      businessId: CARRIER,
      branchId: branch.id,
      vehicleId: TRUCK,
      driverId: DRIVER,
    },
  });

  await prisma.shipper.create({
    data: { id: SHIPPER, name: "Embarcador da Prévia", businessId: CARRIER },
  });

  const delivery = await prisma.delivery.create({
    data: {
      recipient_name: "Cliente",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      businessId: CARRIER,
      shipperId: SHIPPER,
      driverId: DRIVER,
      vehicleId: TRUCK,
    },
  });

  deliveryOnReleased = delivery.id;

  // A released route of the same pair on the day, holding that delivery:
  // the selection empties it, so every branch of the preview runs.
  await prisma.route.create({
    data: {
      code: 1,
      businessId: CARRIER,
      driverId: DRIVER,
      vehicleId: TRUCK,
      scheduled_date: DAY,
      status: "RELEASED",
      stops: {
        create: [{ sequence: 10, deliveryId: delivery.id }],
      },
    },
  });

  await prisma.route.create({
    data: {
      code: 2,
      businessId: CARRIER,
      driverId: DRIVER,
      vehicleId: TRUCK,
      scheduled_date: DAY,
      status: "PLANNED",
    },
  });
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
  await (database as unknown as PrismaClient).$disconnect();
});

describe("the assignment preview", () => {
  it(`holds at most ${BUDGET} connections, with every fact the dialog warns about`, async () => {
    const preview = new AssignmentPreviewUseCase(
      new RouteRepository(),
      new UserRepository(),
    );

    const { peak, result } = await peakOf(() =>
      preview.execute({
        userId: MANAGER,
        businessId: CARRIER,
        driverId: DRIVER,
        vehicleId: TRUCK,
        scheduled_date: DAY,
        deliveryIds: [deliveryOnReleased],
      }),
    );

    // The read is whole: the same answer, fewer connections at a time.
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      "DRIVER_BOOKED_ON_DAY",
      "VEHICLE_OPEN_SERVICE_ORDER",
      "VEHICLE_CHECKLIST_REJECTED",
    ]);
    expect(result.warnings[1].message).toBe(
      `O veículo ${result.vehicle!.license_plate} tem 2 ordens de serviço abertas, a mais antiga desde 10/09/2026.`,
    );

    // Red before: seven queries in one Promise.all.
    expect(peak).toBeLessThanOrEqual(BUDGET);
  });

  it("stops reading once the driver is not the company's", async () => {
    const preview = new AssignmentPreviewUseCase(
      new RouteRepository(),
      new UserRepository(),
    );

    const { peak, total } = await peakOf(() =>
      preview
        .execute({
          userId: MANAGER,
          businessId: CARRIER,
          driverId: randomUUID(),
          vehicleId: TRUCK,
          scheduled_date: DAY,
        })
        .catch((error: { statusCode?: number }) => error),
    );

    expect(peak).toBeLessThanOrEqual(BUDGET);

    // The user, the company's zone and modules, the driver and the vehicle:
    // nothing about routes of a driver that is not there.
    expect(total).toBeLessThanOrEqual(4);
  });
});

describe("the routes board", () => {
  it(`holds at most ${BUDGET} connections with every facet and the search`, async () => {
    const list = new ListRoutesUseCase(
      new RouteRepository(),
      new UserRepository(),
    );

    const { peak, result } = await peakOf(() =>
      list.execute({
        userId: MANAGER,
        businessId: CARRIER,
        page: 1,
        pageSize: 10,
        search: "Prévia",
        statuses: ["PLANNED", "RELEASED"],
        driverIds: [DRIVER],
        vehicleIds: [TRUCK],
      }),
    );

    expect(result.total).toBe(2);
    expect(peak).toBeLessThanOrEqual(BUDGET);
  });
});
