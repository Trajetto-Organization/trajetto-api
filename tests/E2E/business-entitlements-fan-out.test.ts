import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * How many pool connections the company's plan (Limites de Uso, the master's
 * vehicle-limit form) takes at once (tests/E2E/connection-fan-out.test.ts
 * explains the budget: two).
 *
 * It read the modules beside two counts of the fleet — three queries in one
 * Promise.all. One grouped count answers both numbers and the breakdown by
 * status. Measured by wrapping the application's own client, so the use case
 * and its repositories run exactly the code production runs.
 */
const pool = vi.hoisted(() => ({ inFlight: 0, peak: 0, total: 0 }));

vi.mock("@/../infra/database", async () => {
  const { createPrismaClient } = await import(
    "@/shared/database/database-client"
  );

  const counted = createPrismaClient().$extends({
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

import { UserRepository } from "@/modules/user/repositories/user-repository";
import { BusinessRepository } from "@/modules/business/repositories/business-repository";
import { VehicleRepository } from "@/modules/vehicle/repositories/vehicle-repository";
import { GetBusinessEntitlementsUseCase } from "@/modules/business/usecases/manage-entitlements/manage-entitlements-usecase";

const prisma = createPrismaClient();

const CARRIER = "018fef10-0000-7000-8000-00000000000a";
const MANAGER = "018fef10-0000-7000-8000-0000000000a1";

const BUDGET = 2;

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora do Pool do Plano",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: "82333555000183",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `pool-plano-${randomUUID()}@exemplo.com.br`,
      vehicle_limit: 10,
    },
  });

  await prisma.businessEntitlement.create({
    data: { businessId: CARRIER, module: "FLEET", enabled: true },
  });

  await prisma.user.create({
    data: {
      id: MANAGER,
      name: "Gestora",
      email: `pool-plano-gestora-${randomUUID()}@exemplo.com.br`,
      password: "nao-usado",
      role: "BUSINESS_ADMIN",
      businessId: CARRIER,
    },
  });

  const fuelType = await prisma.fuelType.create({
    data: { description: "Diesel", businessId: CARRIER },
  });

  await prisma.vehicle.createMany({
    data: (["ACTIVE", "BLOCKED", "INACTIVE"] as const).map((status, index) => ({
      description: `Caminhão ${index}`,
      license_plate: `POO${1000 + index}`,
      brand: "Volvo",
      model: "FH",
      acquisition_date: new Date("2024-01-10T12:00:00.000Z"),
      fleet_type: "OWNED" as const,
      renavam: `renavam-pool-${randomUUID()}`,
      manufacturing_year: new Date("2024-01-01T12:00:00.000Z"),
      model_year: new Date("2024-01-01T12:00:00.000Z"),
      current_mileage: 1000,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      km_per_liter: 3,
      number_of_axles: 3,
      status,
      businessId: CARRIER,
      fuelTypeId: fuelType.id,
    })),
  });
}, 90_000);

afterAll(async () => {
  await prisma.$disconnect();
  await (database as unknown as PrismaClient).$disconnect();
});

describe("the company's plan, at most two connections", () => {
  it("reads the modules beside ONE grouped count of the fleet", async () => {
    pool.inFlight = 0;
    pool.peak = 0;
    pool.total = 0;

    const plan = await new GetBusinessEntitlementsUseCase(
      new UserRepository(),
      new BusinessRepository(),
      new VehicleRepository(),
    ).execute({ userId: MANAGER, businessId: CARRIER });

    expect(pool.peak, `o plano ocupou ${pool.peak} conexões`).toBe(BUDGET);

    // The caller, the company, then the modules beside the grouped count.
    // Red before: five queries, three of them at once.
    expect(pool.total, `o plano fez ${pool.total} consultas`).toBe(4);

    expect(plan).toMatchObject({
      vehicle_count: 2,
      vehicle_inactive_count: 1,
      vehicle_status_counts: {
        ACTIVE: 1,
        BLOCKED: 1,
        IN_ROUTE: 0,
        INACTIVE: 1,
      },
    });
  });
});
