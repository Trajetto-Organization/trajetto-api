import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

/**
 * How many pool connections the branch, company, quote, activity and Kanban
 * lists
 * take at once (tests/E2E/connection-fan-out.test.ts explains the budget:
 * two). Each reads its page beside one GROUP BY and anything else after —
 * never three queries in parallel, whatever the filters. Measured by
 * wrapping the application's own client, so the repositories run exactly
 * the code production runs.
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

import { BranchRepository } from "@/modules/branch/repositories/branch-repository";
import { BusinessRepository } from "@/modules/business/repositories/business-repository";
import { QuoteRepository } from "@/modules/quote/repositories/quote-repository";
import { ActivityRepository } from "@/modules/activity/repositories/activity-repository";
import { KanbanRepository } from "@/modules/kanban/repositories/kanban-repository";

const prisma = new PrismaClient();

const CARRIER = "018fe900-0000-7000-8000-00000000000a";
const MANAGER = "018fe900-0000-7000-8000-0000000000a1";

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
      corporate_reason: "Transportadora do Pool Administrativo",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: "82222555000182",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `pool-admin-${randomUUID()}@exemplo.com.br`,
    },
  });

  await prisma.user.create({
    data: {
      id: MANAGER,
      name: "Gestora",
      email: `pool-admin-gestora-${randomUUID()}@exemplo.com.br`,
      password: "nao-usado",
      role: "BUSINESS_ADMIN",
      businessId: CARRIER,
    },
  });

  await prisma.branch.createMany({
    data: [0, 1, 2].map((index) => ({
      corporate_reason: `Filial do Pool ${index}`,
      cep: "01001000",
      city: "São Paulo",
      uf: index === 0 ? "RJ" : "SP",
      street: "Rua",
      address_number: "1",
      cnpj: `8222255500026${index}`,
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `pool-branch-${index}-${randomUUID()}@exemplo.com.br`,
      erp_code: index === 1 ? "ERP-1" : null,
      businessId: CARRIER,
    })),
  });

  await prisma.quote.createMany({
    data: [
      { status: "PENDING" as const, fleet_size: "1-5" },
      { status: "CONTACTED" as const, fleet_size: "6-15" },
    ].map((quote, index) => ({
      ...quote,
      name: `Pessoa Pool ${index}`,
      company: "Frota do Pool",
      email: `pool-lead-${index}@exemplo.com.br`,
      telephone: "11988887777",
    })),
  });

  await prisma.activity.createMany({
    data: [0, 1, 2].map((index) => ({
      type: "Filial",
      action: index === 2 ? "delete" : "create",
      entityId: `pool-${index}`,
      description: `Atividade do pool ${index}`,
      status: "Completo",
      performedBy: MANAGER,
      businessId: CARRIER,
    })),
  });

  // A board of five columns, two cards each, one of them assigned.
  for (const index of [0, 1, 2, 3, 4]) {
    await prisma.kanbanColumn.create({
      data: {
        title: index === 0 ? "Pátio" : `Etapa ${index}`,
        color: "#000000",
        position: index,
        businessId: CARRIER,
        cards: {
          create: [0, 1].map((position) => ({
            title: `Tarefa ${index}.${position}`,
            description: position === 0 ? "revisar pneus" : "trocar óleo",
            priority: "medium",
            dueDate: new Date("2026-10-01T12:00:00.000Z"),
            position,
            assignedUserId: position === 0 ? MANAGER : null,
          })),
        },
      },
    });
  }
}, 90_000);

afterAll(async () => {
  await prisma.$disconnect();
  await (database as unknown as PrismaClient).$disconnect();
});

describe("the admin lists, at most two connections", () => {
  it("the branch list, with facets and an order", async () => {
    const { peak, result } = await peakOf(() =>
      new BranchRepository().listAllBranches({
        page: 1,
        pageSize: 10,
        businessId: CARRIER,
        statuses: ["active"],
        ufs: ["SP"],
        sort: "corporate_reason",
        order: "asc",
      }),
    );

    expect(peak, `a lista de filiais ocupou ${peak} conexões`).toBeLessThanOrEqual(BUDGET);
    expect(result.data).toHaveLength(2);
  });

  it("the company list, with its top cities", async () => {
    const { peak, result } = await peakOf(() =>
      new BusinessRepository().listBusiness({
        page: 1,
        pageSize: 10,
        businessId: CARRIER,
        currentUserRole: "MASTER",
        statuses: ["active"],
        ufs: ["SP"],
        sort: "city",
        order: "asc",
      }),
    );

    expect(peak, `a lista de empresas ocupou ${peak} conexões`).toBeLessThanOrEqual(BUDGET);
    expect(result.topCities[0]).toMatchObject({ value: "São Paulo/SP" });
  });

  it("the quote list", async () => {
    const { peak, result } = await peakOf(() =>
      new QuoteRepository().listQuotes({
        page: 1,
        pageSize: 10,
        statuses: ["PENDING", "CONTACTED"],
        fleetSizes: ["1-5"],
        sort: "status",
        order: "asc",
      }),
    );

    expect(peak, `a lista de orçamentos ocupou ${peak} conexões`).toBeLessThanOrEqual(BUDGET);
    expect(result.data).toHaveLength(1);
  });

  it("the activity table and its summary", async () => {
    const repository = new ActivityRepository();

    const table = await peakOf(() =>
      repository.listAllActivities({
        page: 1,
        pageSize: 10,
        currentUserRole: "BUSINESS_ADMIN",
        userId: MANAGER,
        types: ["Filial"],
        actions: ["create"],
      }),
    );

    expect(table.peak, `a tabela de atividades ocupou ${table.peak} conexões`).toBeLessThanOrEqual(
      BUDGET,
    );
    expect(table.result.total).toBe(2);

    const summary = await peakOf(() =>
      repository.summarizeActivities({
        currentUserRole: "BUSINESS_ADMIN",
        userId: MANAGER,
        periodDays: 7,
      }),
    );

    expect(summary.peak, `o resumo de atividades ocupou ${summary.peak} conexões`).toBeLessThanOrEqual(
      BUDGET,
    );
    expect(summary.result).toMatchObject({ total: 3, created: 2, deleted: 1 });
  });

  it("the Kanban board: its cards in one query, not one per column", async () => {
    const repository = new KanbanRepository();

    const board = await peakOf(() => repository.findColumnsByBusinessId(CARRIER, true, 1, 10));

    expect(board.peak, `o quadro ocupou ${board.peak} conexões`).toBeLessThanOrEqual(BUDGET);
    expect(board.result.total).toBe(5);
    expect(board.result.data.map((column) => column.cards?.length)).toEqual([2, 2, 2, 2, 2]);

    // A column found by its title shows every card; the others only the matches.
    const searched = await peakOf(() =>
      repository.findColumnsByBusinessId(CARRIER, true, 1, 10, "pátio"),
    );

    expect(searched.peak).toBeLessThanOrEqual(BUDGET);
    expect(searched.result.data.map((column) => [column.title, column.cards?.length])).toEqual([
      ["Pátio", 2],
    ]);

    const cards = await peakOf(() =>
      repository.findColumnsByBusinessId(CARRIER, true, 1, 10, "pneus"),
    );

    expect(cards.peak).toBeLessThanOrEqual(BUDGET);
    expect(cards.result.total).toBe(5);
    expect(
      cards.result.data.flatMap((column) => column.cards?.map((card) => card.title)),
    ).toEqual(["Tarefa 0.0", "Tarefa 1.0", "Tarefa 2.0", "Tarefa 3.0", "Tarefa 4.0"]);

    // Someone without full Kanban read: only their own cards.
    const own = await peakOf(() =>
      repository.findColumnsByBusinessId(CARRIER, true, 1, 10, undefined, MANAGER),
    );

    expect(own.peak).toBeLessThanOrEqual(BUDGET);
    expect(own.result.data.every((column) => column.cards?.length === 1)).toBe(true);
  });
});
