import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * How many pool connections each Entregas catalog tab takes at once.
 *
 * The four listings used to run the page and its count side by side with a
 * summary of three or four more counts in the same Promise.all: up to six
 * connections for one tab, of the ten a replica has. The budget is two (the
 * rule of tests/E2E/connection-fan-out.test.ts): the page and one GROUP BY;
 * what else a tab needs runs after them.
 *
 * Measured by wrapping the application's own client, so every repository
 * below runs exactly the code production runs.
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

import database from "@/../infra/database";

import { UserRepository } from "@/modules/user/repositories/user-repository";
import { ShipperRepository } from "@/modules/shipper/repositories/shipper-repository";
import { OccurrenceTypeRepository } from "@/modules/occurrence-type/repositories/occurrence-type-repository";
import { StatusChangeReasonRepository } from "@/modules/status-change-reason/repositories/status-change-reason-repository";
import { ImportRepository } from "@/modules/import/repositories/import-repository";

import { ListShipperUseCase } from "@/modules/shipper/usecases/list-shipper/list-shipper-usecase";
import { ListOccurrenceTypeUseCase } from "@/modules/occurrence-type/usecases/list-occurrence-type/list-occurrence-type-usecase";
import { ListStatusChangeReasonUseCase } from "@/modules/status-change-reason/usecases/list-status-change-reason/list-status-change-reason-usecase";
import { ListImportsUseCase } from "@/modules/import/usecases/list-imports/list-imports-usecase";

const prisma = createPrismaClient();

const CARRIER = "018fde00-0000-7000-8000-00000000000a";
const MANAGER = "018fde00-0000-7000-8000-0000000000a1";

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
      corporate_reason: "Transportadora dos Catálogos",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(72000000000000 + Math.floor(Math.random() * 9000000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `catalogos-${randomUUID()}@exemplo.com.br`,
    },
  });

  await prisma.user.create({
    data: {
      id: MANAGER,
      name: "Gestora",
      email: `catalogos-gestora-${randomUUID()}@exemplo.com.br`,
      password: "nao-usado",
      role: "BUSINESS_ADMIN",
      businessId: CARRIER,
    },
  });

  await prisma.shipper.createMany({
    data: [
      { name: "Embarcador A", businessId: CARRIER },
      { name: "Embarcador B", businessId: CARRIER, is_active: false },
    ],
  });

  await prisma.occurrenceType.createMany({
    data: [
      { name: "Avaria", businessId: CARRIER, blocks_delivery: true },
      { name: "Atraso", businessId: CARRIER },
    ],
  });

  await prisma.statusChangeReason.createMany({
    data: [
      { name: "Cliente ligou", businessId: CARRIER },
      { name: "Aposentado", businessId: CARRIER, is_active: false },
    ],
  });

  await prisma.import.create({
    data: {
      source: "SPREADSHEET",
      filename: "dia.csv",
      report: {},
      businessId: CARRIER,
      performedById: MANAGER,
    },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
  await (database as unknown as PrismaClient).$disconnect();
});

const page = { userId: MANAGER, page: 1, pageSize: 10 };

describe("the Entregas catalog tabs stay within two connections", () => {
  it("the shippers tab", async () => {
    const useCase = new ListShipperUseCase(
      new UserRepository(),
      new ShipperRepository(),
    );

    const { peak, result } = await peakOf(() =>
      useCase.execute({ ...page, statuses: ["active"] }),
    );

    expect(result.total).toBe(1);
    expect(peak).toBeLessThanOrEqual(BUDGET);
  });

  it("the occurrence types tab", async () => {
    const useCase = new ListOccurrenceTypeUseCase(
      new UserRepository(),
      new OccurrenceTypeRepository(),
    );

    const { peak, result } = await peakOf(() =>
      useCase.execute({ ...page, blocking: ["yes"] }),
    );

    expect(result.total).toBe(1);
    expect(peak).toBeLessThanOrEqual(BUDGET);
  });

  it("the status change reasons tab", async () => {
    const useCase = new ListStatusChangeReasonUseCase(
      new UserRepository(),
      new StatusChangeReasonRepository(),
    );

    const { peak, result } = await peakOf(() => useCase.execute(page));

    expect(result.meta).toMatchObject({ total: 2, active: 1, used: 0 });
    expect(peak).toBeLessThanOrEqual(BUDGET);
  });

  it("the imports tab", async () => {
    const useCase = new ListImportsUseCase(
      new UserRepository(),
      new ImportRepository(),
    );

    const { peak, result } = await peakOf(() => useCase.execute(page));

    expect(result.total).toBe(1);
    expect(peak).toBeLessThanOrEqual(BUDGET);
  });
});
