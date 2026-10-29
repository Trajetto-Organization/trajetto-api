import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { randomUUID } from "node:crypto";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * The fines screen takes at most two connections at a time (the budget of
 * tests/E2E/connection-fan-out.test.ts): the page on one, the three status
 * groupings in sequence on the other, the names after. Measured by wrapping
 * the application's own client, so the repository runs as in production.
 */
const pool = vi.hoisted(() => ({ inFlight: 0, peak: 0 }));

vi.mock("@/../infra/database", async () => {
  const { createPrismaClient } = await import(
    "@/shared/database/database-client"
  );

  const counted = createPrismaClient().$extends({
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

import { FineRepository } from "@/modules/fine/repositories/fine-repository";
import { BusinessRepository } from "@/modules/business/repositories/business-repository";
import { UserRepository } from "@/modules/user/repositories/user-repository";
import { ListFineUseCase } from "@/modules/fine/usecases/list-fine/list-fine-usecase";

const prisma = createPrismaClient();

const BUSINESS = randomUUID();
const MANAGER = randomUUID();

const BUDGET = 2;

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: BUSINESS,
      corporate_reason: "Transportadora das Multas",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(72000000000000 + Math.floor(Math.random() * 9000000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `fines-${randomUUID()}@exemplo.com.br`,
    },
  });

  await prisma.user.create({
    data: {
      id: MANAGER,
      name: "Gestora",
      email: `fines-gestora-${randomUUID()}@exemplo.com.br`,
      password: "nao-usado",
      role: "BUSINESS_ADMIN",
      businessId: BUSINESS,
    },
  });

  const branch = await prisma.branch.create({
    data: {
      corporate_reason: "Filial",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(73000000000000 + Math.floor(Math.random() * 9000000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `fines-branch-${randomUUID()}@exemplo.com.br`,
      businessId: BUSINESS,
    },
  });

  const driver = await prisma.driver.create({
    data: {
      name: "Motorista",
      birth_date: new Date("1990-01-01"),
      cnh: `CNH${randomUUID().slice(0, 8)}`,
      cpf: randomUUID().slice(0, 11),
      rg: randomUUID().slice(0, 9),
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId: BUSINESS,
    },
  });

  const fuelType = await prisma.fuelType.create({
    data: { description: "Diesel", businessId: BUSINESS },
  });

  const vehicle = await prisma.vehicle.create({
    data: {
      description: "Caminhão",
      license_plate: "FAN1O01",
      brand: "Scania",
      model: "R450",
      acquisition_date: new Date(),
      fleet_type: "OWNED",
      current_mileage: 0,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: `rnv-${randomUUID().slice(0, 8)}`,
      manufacturing_year: new Date(),
      model_year: new Date(),
      km_per_liter: 3,
      number_of_axles: 3,
      status: "ACTIVE",
      businessId: BUSINESS,
      fuelTypeId: fuelType.id,
    },
  });

  const code = await prisma.trafficViolationCode.create({
    data: {
      code: "7455",
      description: "Velocidade",
      legal_basis: "CTB",
      violator_type: "Condutor",
      gravity: "MEDIUM",
      gravity_raw: "Média",
      points: 4,
      competent_agency: "Estadual",
    },
  });

  const day = 24 * 60 * 60 * 1000;

  // One of each status.
  for (const [due, paid] of [
    [-10, true],
    [-10, false],
    [10, false],
  ] as const) {
    await prisma.fine.create({
      data: {
        businessId: BUSINESS,
        branchId: branch.id,
        driverId: driver.id,
        vehicleId: vehicle.id,
        trafficViolationCodeId: code.id,
        violation_date: new Date(Date.now() - 30 * day),
        due_date: new Date(Date.now() + due * day),
        payment_date: paid ? new Date(Date.now() - 20 * day) : null,
        amount: 100,
        points: 4,
      },
    });
  }
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe("the fines list", () => {
  it("takes at most two connections at a time", async () => {
    const useCase = new ListFineUseCase(
      new UserRepository(),
      new BusinessRepository(),
      new FineRepository(),
    );

    pool.inFlight = 0;
    pool.peak = 0;

    const result = await useCase.execute({
      userId: MANAGER,
      page: 1,
      pageSize: 10,
    });

    expect(
      pool.peak,
      `a listagem ocupou ${pool.peak} conexões`,
    ).toBeLessThanOrEqual(BUDGET);
    expect(result.total).toBe(3);
    expect(result.searchMeta).toMatchObject({
      paid: 1,
      overdue: 1,
      pending: 1,
    });
  });
});
