import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

/**
 * Connections per request for the reads the db-perf pass (10/2026) found
 * above the budget of tests/E2E/connection-fan-out.test.ts: two — a page and
 * one count side by side, everything else after them.
 *
 * A replica has ten (connection_limit=10, the production DATABASE_URL in
 * .env.example). The route builder's picker took six at once, the ticket
 * counters and the webhook monitor five, a branch deletion seven: two route
 * builders opening together held the whole pool, and a proof of delivery (a
 * write in a transaction) waited behind them. With the indexes of 20261007120000 each of those
 * queries takes milliseconds, so running them in turn costs little and keeps
 * the pool for everyone else.
 *
 * Measured on the application's own client, wrapped, so every repository runs
 * exactly the code production runs.
 */
const pool = vi.hoisted(() => ({ inFlight: 0, peak: 0, operations: 0 }));

vi.mock("@/../infra/database", async () => {
  const { PrismaClient: Client } = await import("@prisma/client");

  const counted = new Client().$extends({
    query: {
      async $allOperations({ args, query }) {
        pool.inFlight += 1;
        pool.operations += 1;
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

import { RouteRepository } from "@/modules/route/repositories/route-repository";
import { SupportTicketRepository } from "@/modules/chat/repositories/support-ticket-repository";
import { WebhookDeliveryRepository } from "@/modules/integration/repositories/webhook-delivery-repository";
import { ProofAuditRepository } from "@/modules/delivery/repositories/proof-audit-repository";
import { ChatRepository } from "@/modules/chat/repositories/chat-repository";
import { BranchRepository } from "@/modules/branch/repositories/branch-repository";

const prisma = new PrismaClient();

const BUDGET = 2;

const CARRIER = randomUUID();
const MANAGER = randomUUID();

async function peakOf<T>(
  run: () => Promise<T>,
): Promise<{ peak: number; operations: number; result: T }> {
  pool.inFlight = 0;
  pool.peak = 0;
  pool.operations = 0;

  const result = await run();

  return { peak: pool.peak, operations: pool.operations, result };
}

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: `Transportadora das Conexões ${CARRIER.slice(0, 8)}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(55000000000000 + Math.floor(Math.random() * 9_000_000_000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `conexoes-${randomUUID()}@exemplo.com.br`,
    },
  });

  await prisma.user.create({
    data: {
      id: MANAGER,
      name: "Gestora",
      email: `conexoes-${MANAGER}@exemplo.com.br`,
      password: "nao-usado",
      role: "BUSINESS_ADMIN",
      businessId: CARRIER,
    },
  });

  const shipper = await prisma.shipper.create({
    data: { name: "Embarcador", businessId: CARRIER },
  });

  await prisma.delivery.createMany({
    data: Array.from({ length: 5 }, (_, index) => ({
      recipient_name: `Cliente ${index}`,
      city: index % 2 ? "Campinas" : "Santos",
      uf: "SP",
      street: "Rua",
      status: "PENDING" as const,
      businessId: CARRIER,
      shipperId: shipper.id,
    })),
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("reads that held more than two connections", () => {
  it(`the route builder's picker holds at most ${BUDGET}, with every facet`, async () => {
    const { peak, result } = await peakOf(() =>
      new RouteRepository().listUnroutedDeliveries({
        businessId: CARRIER,
        page: 1,
        pageSize: 20,
        includeUnscheduled: true,
      }),
    );

    expect(result.total).toBe(5);
    expect(result.facets.city.map((facet) => facet.value).sort()).toEqual([
      "Campinas",
      "Santos",
    ]);
    expect(peak).toBeLessThanOrEqual(BUDGET);
  });

  it(`the ticket counters hold at most ${BUDGET}`, async () => {
    const { peak, result } = await peakOf(() =>
      new SupportTicketRepository().counts({
        businessId: CARRIER,
        requesterUserId: MANAGER,
      }),
    );

    expect(result.open).toBe(0);
    expect(peak).toBeLessThanOrEqual(BUDGET);
  });

  it(`the webhook monitor holds at most ${BUDGET}`, async () => {
    const { peak, result } = await peakOf(() =>
      new WebhookDeliveryRepository().monitor({
        businessId: CARRIER,
        since: new Date(Date.now() - 7 * 86_400_000),
        page: 1,
        pageSize: 20,
        cap: 1_000,
      }),
    );

    expect(result.counted).toBe(0);
    expect(peak).toBeLessThanOrEqual(BUDGET);
  });

  it(`the proof audit queue holds at most ${BUDGET}`, async () => {
    const { peak } = await peakOf(() =>
      new ProofAuditRepository().listQueue({
        businessId: CARRIER,
        status: "PENDING",
        page: 1,
        pageSize: 20,
        agreementSince: new Date(Date.now() - 90 * 86_400_000),
      }),
    );

    expect(peak).toBeLessThanOrEqual(BUDGET);
  });

  it(`the conversations list holds at most ${BUDGET}`, async () => {
    const { peak, result } = await peakOf(() =>
      new ChatRepository().listThreads({
        businessId: CARRIER,
        requesterUserId: MANAGER,
        page: 1,
        pageSize: 20,
      }),
    );

    expect(result.total).toBe(0);
    expect(peak).toBeLessThanOrEqual(BUDGET);
  });

  it(`a branch's dependency check holds at most ${BUDGET}`, async () => {
    const { peak, result } = await peakOf(() =>
      new BranchRepository().countBranchDependencies(randomUUID()),
    );

    expect(Object.values(result).every((count) => count === 0)).toBe(true);
    expect(peak).toBeLessThanOrEqual(BUDGET);
  });

  it("a branch's dependency check is one statement, with the right counts and nothing of another branch", async () => {
    const branchOf = async (cnpjSeed: number) =>
      prisma.branch.create({
        data: {
          corporate_reason: `Filial ${cnpjSeed}`,
          cep: "01001000",
          city: "São Paulo",
          uf: "SP",
          street: "Rua",
          address_number: "1",
          cnpj: String(56000000000000 + cnpjSeed),
          cnae: "4930202",
          responsible_name: "Responsável",
          telephone: "11999999999",
          email: `filial-${randomUUID()}@exemplo.com.br`,
          businessId: CARRIER,
        },
      });

    const seed = Math.floor(Math.random() * 9_000_000_000);
    const branch = await branchOf(seed);
    const other = await branchOf(seed + 1);

    const driverIn = (branchId: string, index: number) =>
      prisma.driver.create({
        data: {
          name: `Motorista ${index}`,
          birth_date: new Date("1985-01-01"),
          cnh: String(10000000000 + seed + index),
          cpf: String(20000000000 + seed + index),
          rg: "RG",
          cep: "01001000",
          city: "São Paulo",
          uf: "SP",
          street: "Rua",
          address_number: "1",
          status: "ACTIVE",
          contract_type: "OWNED",
          businessId: CARRIER,
          branchId,
        },
      });

    await driverIn(branch.id, 1);
    await driverIn(branch.id, 2);
    await driverIn(other.id, 3);

    const { peak, operations, result } = await peakOf(() =>
      new BranchRepository().countBranchDependencies(branch.id),
    );

    expect(result).toEqual({
      vehicles: 0,
      drivers: 2,
      serviceOrders: 0,
      accountsPayable: 0,
      fines: 0,
      fuels: 0,
      vehicleChecklists: 0,
    });
    // One round trip, not seven.
    expect(operations).toBe(1);
    expect(peak).toBe(1);
  });
});
