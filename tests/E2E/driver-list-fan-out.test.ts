import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

/**
 * How many pool connections the driver list takes at once
 * (tests/E2E/connection-fan-out.test.ts explains the budget: two).
 *
 * The list reads a page and one GROUP BY side by side, then the branch names
 * of the filter — never three queries in parallel, whatever the filters.
 * Measured by wrapping the application's own client, so the repository runs
 * exactly the code production runs.
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

import { DriverRepository } from "@/modules/driver/repositories/driver-repository";

const prisma = new PrismaClient();

const CARRIER = "018fe800-0000-7000-8000-00000000000a";
const BRANCH = "018fe800-0000-7000-8000-0000000000b1";

const BUDGET = 2;

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora do Pool de Motoristas",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: "81222555000181",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `pool-${randomUUID()}@exemplo.com.br`,
    },
  });

  await prisma.branch.create({
    data: {
      id: BRANCH,
      corporate_reason: "Filial do Pool",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: "81222555000262",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `pool-branch-${randomUUID()}@exemplo.com.br`,
      businessId: CARRIER,
    },
  });

  for (let index = 0; index < 3; index += 1) {
    await prisma.driver.create({
      data: {
        name: `Motorista ${index}`,
        birth_date: new Date("1990-01-01"),
        cnh: `1234567890${index}`,
        cpf: `9876543210${index}`,
        rg: "123456789",
        cep: "01001000",
        city: "São Paulo",
        uf: "SP",
        street: "Rua",
        address_number: "1",
        status: index === 0 ? "INACTIVE" : "ACTIVE",
        contract_type: "OWNED",
        businessId: CARRIER,
        branchId: BRANCH,
      },
    });
  }
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe("the driver list's connection budget", () => {
  it("stays within two connections with search, every facet and a sort", async () => {
    pool.inFlight = 0;
    pool.peak = 0;

    const result = await new DriverRepository().listDrivers({
      page: 1,
      pageSize: 10,
      businessId: CARRIER,
      search: "Motorista",
      sort: "name",
      order: "asc",
      statuses: ["ACTIVE"],
      contractTypes: ["OWNED"],
      cnhCategories: ["NONE"],
      branchIds: [BRANCH],
    });

    expect(
      pool.peak,
      `a lista de motoristas ocupou ${pool.peak} conexões`,
    ).toBeLessThanOrEqual(BUDGET);
    expect(result.data.map((row) => row.name)).toEqual([
      "Motorista 1",
      "Motorista 2",
    ]);
    expect(result.branchNames.get(BRANCH)).toBe("Filial do Pool");
  });
});
