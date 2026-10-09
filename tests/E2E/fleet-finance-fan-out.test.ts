import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

/**
 * The accounts payable and supplier lists within the connection budget of a
 * screen (two at a time), measured like tests/E2E/connection-fan-out.test.ts:
 * the application's own client is wrapped, so the repositories and use cases
 * below run exactly the code production runs. A separate file so the lists of
 * this package do not edit the shared one.
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

import { UserRepository } from "@/modules/user/repositories/user-repository";
import { BusinessRepository } from "@/modules/business/repositories/business-repository";
import { AccountPayableRepository } from "@/modules/account-payable/repositories/account-payable-repository";
import { SupplierRepository } from "@/modules/supplier/repositories/supplier-repository";

import { ListAccountPayableUseCase } from "@/modules/account-payable/usecases/list-account-payable/list-account-payable-usecase";
import { ListSupplierUseCase } from "@/modules/supplier/usecases/list-supplier/list-supplier-usecase";

const prisma = new PrismaClient();

const CARRIER = "018fe400-0000-7000-8000-00000000000a";
const MANAGER = "018fe400-0000-7000-8000-0000000000a1";

const BUDGET = 2;

async function peakOf<T>(run: () => Promise<T>): Promise<{ peak: number; result: T }> {
  pool.inFlight = 0;
  pool.peak = 0;

  const result = await run();

  return { peak: pool.peak, result };
}

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora do Pool Financeiro",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(72000000000000 + Math.floor(Math.random() * 9000000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `pool-fin-${randomUUID()}@exemplo.com.br`,
    },
  });

  await prisma.user.create({
    data: {
      id: MANAGER,
      name: "Gestora",
      email: `pool-fin-gestora-${randomUUID()}@exemplo.com.br`,
      password: "nao-usado",
      role: "BUSINESS_ADMIN",
      businessId: CARRIER,
    },
  });

  const branch = await prisma.branch.create({
    data: {
      corporate_reason: "Filial do Pool",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(73000000000000 + Math.floor(Math.random() * 9000000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `pool-fin-filial-${randomUUID()}@exemplo.com.br`,
      businessId: CARRIER,
    },
  });

  await prisma.supplier.createMany({
    data: [
      { name: "Oficina SP", cnpj: "11111111000111", uf: "SP", businessId: CARRIER },
      { name: "Oficina MG", cnpj: "22222222000122", uf: "MG", businessId: CARRIER },
    ],
  });

  await prisma.accountPayable.createMany({
    data: [
      { due_date: new Date(Date.now() + 86_400_000 * 3), amount: 100 },
      { due_date: new Date(Date.now() - 86_400_000 * 3), amount: 200 },
      {
        due_date: new Date(Date.now() - 86_400_000 * 3),
        amount: 300,
        amount_paid: 300,
        payment_date: new Date(),
      },
    ].map((bill) => ({
      ...bill,
      category: "MAINTENANCE" as const,
      businessId: CARRIER,
      branchId: branch.id,
      registrationUserId: MANAGER,
      payee_name: "Favorecido",
    })),
  });
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
  await (database as unknown as PrismaClient).$disconnect();
});

describe("one screen, at most two connections", () => {
  it("the accounts payable list, with its cards", async () => {
    const useCase = new ListAccountPayableUseCase(
      new UserRepository(),
      new BusinessRepository(),
      new AccountPayableRepository(),
    );

    const { peak, result } = await peakOf(() =>
      useCase.execute({ userId: MANAGER, page: 1, pageSize: 10 }),
    );

    expect(peak, `as contas a pagar ocuparam ${peak} conexões`).toBeLessThanOrEqual(BUDGET);
    expect(result.searchMeta).toMatchObject({ total: 3, open: 1, overdue: 1, paid: 1 });
  });

  it("the supplier list, with its cards", async () => {
    const useCase = new ListSupplierUseCase(
      new UserRepository(),
      new SupplierRepository(),
    );

    const { peak, result } = await peakOf(() =>
      useCase.execute({ userId: MANAGER, page: 1, pageSize: 10 }),
    );

    expect(peak, `os fornecedores ocuparam ${peak} conexões`).toBeLessThanOrEqual(BUDGET);
    expect(result.total).toBe(2);
    expect(result.searchMeta.topStates).toBe("MG (1), SP (1)");
  });
});
