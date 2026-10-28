import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

/**
 * How many connections one screen takes from the pool at the same time.
 *
 * Every query Prisma runs in parallel takes its own connection, and a replica
 * has ten. The operations summary fired seven queries in one Promise.all, the
 * vehicle block of the dashboard six, the occurrence list four, the control
 * tower four, the delivery list three. Two dashboards opening at once asked
 * for fourteen connections, and the driver's proof of delivery — a write in a
 * transaction — queued behind them. The dashboard repository already learned
 * this the hard way once (nine parallel counts made the API's p95 fifteen
 * times worse); these screens were written after that lesson.
 *
 * The budget asserted here is two: a page and its count may still run side by
 * side, nothing else does.
 *
 * Measured by wrapping the application's own client, so every repository and
 * use case below runs exactly the code production runs.
 */
const pool = vi.hoisted(() => ({ inFlight: 0, peak: 0 }));

vi.mock("@/../infra/database", async () => {
  const { PrismaClient: Client } = await import("@prisma/client");

  const counted = new Client().$extends({
    query: {
      async $allOperations({ args, query }) {
        pool.inFlight += 1;
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

import { DeliveryRepository } from "@/modules/delivery/repositories/delivery-repository";
import { DashboardRepository } from "@/modules/dashboard/repositories/dashboard-repository";
import { UserRepository } from "@/modules/user/repositories/user-repository";
import { ActivityRepository } from "@/modules/activity/repositories/activity-repository";
import { BusinessRepository } from "@/modules/business/repositories/business-repository";
import { DriverPositionRepository } from "@/modules/route/repositories/driver-position-repository";

import { DEFAULT_BUSINESS_TIMEZONE } from "@/shared/time/business-day";
import { operationDay } from "@/shared/route/operation-day-rules";

import { readOperationSummary } from "@/modules/delivery/usecases/operation-summary/read-operation-summary";
import { GetDashboardOverviewUseCase } from "@/modules/dashboard/usecases/get-dashboard-overview/get-dashboard-overview-usecase";
import { ListDeliveryUseCase } from "@/modules/delivery/usecases/list-delivery/list-delivery-usecase";
import { ListOccurrencesUseCase } from "@/modules/delivery/usecases/list-occurrences/list-occurrences-usecase";
import { ControlTowerUseCase } from "@/modules/route/usecases/control-tower/control-tower-usecase";
import { OperationDayRepository } from "@/modules/route/repositories/operation-day-repository";

const prisma = new PrismaClient();

const CARRIER = "018fdb00-0000-7000-8000-00000000000a";
const MANAGER = "018fdb00-0000-7000-8000-0000000000a1";
const DRIVER = "018fdb00-0000-7000-8000-0000000000d1";
const DRIVER_USER = "018fdb00-0000-7000-8000-0000000000a2";
const SHIPPER = "018fdb00-0000-7000-8000-0000000000f1";
const TYPE = "018fdb00-0000-7000-8000-0000000000c1";

const BUDGET = 2;

async function peakOf<T>(
  run: () => Promise<T>,
): Promise<{ peak: number; result: T }> {
  pool.inFlight = 0;
  pool.peak = 0;

  const result = await run();

  return { peak: pool.peak, result };
}

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora do Pool",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(71000000000000 + Math.floor(Math.random() * 9000000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `pool-${randomUUID()}@exemplo.com.br`,
    },
  });

  await prisma.businessEntitlement.create({
    data: { businessId: CARRIER, module: "DELIVERIES", enabled: true },
  });

  await prisma.user.create({
    data: {
      id: MANAGER,
      name: "Gestora",
      email: `pool-gestora-${randomUUID()}@exemplo.com.br`,
      password: "nao-usado",
      role: "BUSINESS_ADMIN",
      businessId: CARRIER,
    },
  });

  await prisma.driver.create({
    data: {
      id: DRIVER,
      name: "Motorista do Pool",
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

  await prisma.shipper.create({
    data: { id: SHIPPER, name: "Embarcador do Pool", businessId: CARRIER },
  });

  const fuelType = await prisma.fuelType.create({
    data: { description: "Diesel", businessId: CARRIER },
  });

  for (const status of ["ACTIVE", "BLOCKED"] as const) {
    await prisma.vehicle.create({
      data: {
        description: "Caminhão",
        license_plate: `POL${status[0]}${Math.floor(Math.random() * 9000) + 1000}`,
        brand: "Volvo",
        model: "FH",
        acquisition_date: new Date(),
        fleet_type: "OWNED",
        current_mileage: 0,
        maintenance_interval_km: 10000,
        maintenance_interval_months: 6,
        renavam: `renavam-pool-${randomUUID()}`,
        manufacturing_year: new Date(),
        model_year: new Date(),
        km_per_liter: 3,
        number_of_axles: 3,
        status,
        businessId: CARRIER,
        fuelTypeId: fuelType.id,
      },
    });
  }

  const base = {
    businessId: CARRIER,
    shipperId: SHIPPER,
    recipient_name: "Cliente",
    cep: "01001000",
    city: "São Paulo",
    uf: "SP",
    street: "Rua",
    address_number: "10",
  };

  const yesterday = new Date(Date.now() - 36 * 60 * 60 * 1000);

  /**
   * One row per number the summary reports, plus the rows it must NOT count:
   * a delivery finished yesterday and a failure that moved yesterday. Each
   * total then has exactly one right answer, and a rewrite that drops a
   * condition or the driverless rows gets a different one.
   */
  await prisma.delivery.createMany({
    data: [
      { ...base, code: "P-1", status: "PENDING" },
      { ...base, code: "P-2", status: "PENDING", driverId: DRIVER },
      { ...base, code: "T-1", status: "IN_TRANSIT", driverId: DRIVER },
      {
        ...base,
        code: "D-1",
        status: "DELIVERED",
        driverId: DRIVER,
        delivered_at: new Date(),
      },
      {
        ...base,
        code: "D-2",
        status: "DELIVERED",
        driverId: DRIVER,
        delivered_at: yesterday,
      },
      { ...base, code: "F-1", status: "FAILED" },
      { ...base, code: "F-2", status: "FAILED", driverId: DRIVER },
    ],
  });

  // `updated_at` is @updatedAt, so the only way to date a change yesterday is
  // under Prisma's feet.
  await prisma.$executeRaw`
    UPDATE "delivery" SET "updated_at" = ${yesterday}
    WHERE "businessId" = ${CARRIER} AND "code" = 'F-2'
  `;

  await prisma.occurrenceType.create({
    data: { id: TYPE, name: "Ausente", businessId: CARRIER },
  });

  const pending = await prisma.delivery.findFirstOrThrow({
    where: { businessId: CARRIER, code: "P-2" },
  });

  // "Ocorrências hoje" counts the driver's reports: the driver's account.
  await prisma.user.create({
    data: {
      id: DRIVER_USER,
      name: "Motorista do Pool",
      email: `pool-motorista-${randomUUID()}@exemplo.com.br`,
      password: "nao-usado",
      role: "BUSINESS_USER",
      businessId: CARRIER,
      driverId: DRIVER,
    },
  });

  await prisma.deliveryOccurrence.create({
    data: {
      deliveryId: pending.id,
      businessId: CARRIER,
      occurrenceTypeId: TYPE,
      reportedById: DRIVER_USER,
    },
  });
}, 120_000);

afterAll(async () => {
  await prisma.deliveryOccurrence.deleteMany({
    where: { businessId: CARRIER },
  });
  await prisma.delivery.deleteMany({ where: { businessId: CARRIER } });
  await prisma.$disconnect();
  await (database as unknown as PrismaClient).$disconnect();
});

describe("the counter itself", () => {
  it("sees queries that run side by side", async () => {
    // Without this, a counter that saw nothing would pass every test below.
    const { peak } = await peakOf(() =>
      Promise.all([
        database.$queryRaw`SELECT 1 AS a FROM pg_sleep(0.2)`,
        database.$queryRaw`SELECT 1 AS b FROM pg_sleep(0.2)`,
        database.delivery.count({ where: { businessId: CARRIER } }),
      ]),
    );

    expect(peak).toBe(3);
  });
});

describe("one screen, at most two connections", () => {
  it("the operations summary", async () => {
    const { peak, result } = await peakOf(() =>
      readOperationSummary(
        {
          operation: new OperationDayRepository(),
          delivery: new DeliveryRepository(),
        },
        CARRIER,
        operationDay(DEFAULT_BUSINESS_TIMEZONE, new Date()),
      ),
    );

    expect(
      peak,
      `o resumo da operação ocupou ${peak} conexões`,
    ).toBeLessThanOrEqual(BUDGET);

    // And it still says the same thing.
    // P-2 has a driver and no route of the day: not designated, as in the
    // tower's funnel (decision 7.1).
    expect(result.totals).toEqual({
      unassigned: 1,
      designated: 0,
      inRoute: 1,
      deliveredToday: 1,
      failedToday: 1,
      occurrencesToday: 1,
    });

    expect(result.drivers).toEqual([
      expect.objectContaining({
        driverId: DRIVER,
        driverName: "Motorista do Pool",
        designated: 0,
        inRoute: 1,
        deliveredToday: 1,
        failedToday: 0,
      }),
    ]);
  });

  it("the vehicle counts by status", async () => {
    const { peak, result } = await peakOf(() =>
      new DashboardRepository().countVehiclesByStatus(CARRIER),
    );

    expect(
      peak,
      `a contagem de veículos ocupou ${peak} conexões`,
    ).toBeLessThanOrEqual(BUDGET);
    expect(result).toEqual({ ACTIVE: 1, INACTIVE: 0, BLOCKED: 1, IN_ROUTE: 0 });
  });

  it("the dashboard", async () => {
    const useCase = new GetDashboardOverviewUseCase(
      new UserRepository(),
      new DashboardRepository(),
      new ActivityRepository(),
      new DeliveryRepository(),
      new BusinessRepository(),
      new OperationDayRepository(),
    );

    const { peak, result } = await peakOf(() =>
      useCase.execute({ userId: MANAGER }),
    );

    expect(peak, `o dashboard ocupou ${peak} conexões`).toBeLessThanOrEqual(
      BUDGET,
    );

    expect(result.vehicleStatus).toEqual({
      ACTIVE: 1,
      INACTIVE: 0,
      BLOCKED: 1,
      IN_ROUTE: 0,
    });

    expect(result.deliveryOperation).toMatchObject({
      unassigned: 1,
      designated: 0,
      inRoute: 1,
      deliveredToday: 1,
      failedToday: 1,
    });
  });

  it("the delivery list", async () => {
    const useCase = new ListDeliveryUseCase(
      new UserRepository(),
      new DeliveryRepository(),
      new BusinessRepository(),
    );

    const { peak, result } = await peakOf(() =>
      useCase.execute({ userId: MANAGER, page: 1, pageSize: 10 }),
    );

    expect(peak, `a listagem ocupou ${peak} conexões`).toBeLessThanOrEqual(
      BUDGET,
    );
    expect(result.total).toBe(7);
    expect(result.data).toHaveLength(7);
  });

  it("the occurrence list", async () => {
    const useCase = new ListOccurrencesUseCase(
      new UserRepository(),
      new DeliveryRepository(),
      { getFileUrl: async (key: string) => key } as never,
    );

    const { peak, result } = await peakOf(() =>
      useCase.execute({ userId: MANAGER, page: 1, pageSize: 10 }),
    );

    expect(
      peak,
      `as ocorrências ocuparam ${peak} conexões`,
    ).toBeLessThanOrEqual(BUDGET);
    expect(result.searchMeta).toMatchObject({
      total: 1,
      blocking: 0,
      informational: 1,
    });
    expect(result.total).toBe(1);
  });

  it("the control tower", async () => {
    const useCase = new ControlTowerUseCase(
      new UserRepository(),
      new DriverPositionRepository(),
      new OperationDayRepository(),
    );

    const { peak, result } = await peakOf(() =>
      useCase.execute({ userId: MANAGER }),
    );

    expect(peak, `a torre ocupou ${peak} conexões`).toBeLessThanOrEqual(BUDGET);
    expect(result.funnel).toBeDefined();
  });
});
