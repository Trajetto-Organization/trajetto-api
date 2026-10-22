import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { ActivityRepository } from "@/modules/activity/repositories/activity-repository";
import { BusinessRepository } from "@/modules/business/repositories/business-repository";
import { DashboardRepository } from "@/modules/dashboard/repositories/dashboard-repository";
import { OperationDayRepository } from "@/modules/route/repositories/operation-day-repository";
import { DeliveryRepository } from "@/modules/delivery/repositories/delivery-repository";
import { UserRepository } from "@/modules/user/repositories/user-repository";
import { GetDashboardOverviewUseCase } from "@/modules/dashboard/usecases/get-dashboard-overview/get-dashboard-overview-usecase";

/**
 * The five lines of "recent activity" on the dashboard, and what they cost.
 *
 * The overview used the paginated listing for them, which always runs a
 * COUNT next to the page. The dashboard threw the total away, but the database
 * still counted the company's whole activity trail — a table with no retention
 * by default, written by every proof, arrival and status change — on the
 * screen every session lands on after login. For a MASTER there is no tenant
 * at all, so it counted the entire table.
 *
 * Nothing about the rows proves that: they are correct either way. Only the
 * statements the database was asked to run show it, so this counts them.
 */
const prisma = new PrismaClient();

const counted = new PrismaClient({
  log: [{ level: "query", emit: "event" }],
});

const CARRIER = "018fd310-0000-7000-8000-00000000000a";
const ADMIN = "018fd310-0000-7000-8000-0000000000a1";
const MASTER = "018fd310-0000-7000-8000-0000000000b1";

const statements: string[] = [];

function activityCounts(): string[] {
  // Prisma 6 wraps a filtered count in a sub-select
  // (`SELECT COUNT(*) FROM (SELECT "public"."activity"."id" ...) AS "sub"`),
  // so the match is on the two ingredients rather than on one exact text.
  return statements.filter(
    (sql) => /COUNT\(/i.test(sql) && sql.includes('"activity"'),
  );
}

async function overviewFor(userId: string): Promise<any> {
  const useCase = new GetDashboardOverviewUseCase(
    new UserRepository(),
    new DashboardRepository(),
    new ActivityRepository(counted),
    new DeliveryRepository(),
    new BusinessRepository(),
    new OperationDayRepository(),
  );

  statements.length = 0;

  return useCase.execute({ userId });
}

beforeAll(async () => {
  counted.$on("query" as never, (event: { query: string }) => {
    statements.push(event.query);
  });

  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora da Atividade Recente",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(81000000000000 + Math.floor(Math.random() * 9000000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `atividade-${randomUUID()}@exemplo.com.br`,
    },
  });

  await prisma.user.createMany({
    data: [
      {
        id: ADMIN,
        name: "Administradora",
        email: `admin-${randomUUID()}@exemplo.com.br`,
        password: "nao-usado",
        role: "BUSINESS_ADMIN",
        businessId: CARRIER,
      },
      {
        id: MASTER,
        name: "Master",
        email: `master-${randomUUID()}@exemplo.com.br`,
        password: "nao-usado",
        role: "MASTER",
      },
    ],
  });

  // Seven rows, one minute apart, so "the five most recent" has a single
  // right answer and two rows that must be left out.
  const base = Date.now() - 60 * 60_000;

  await prisma.activity.createMany({
    data: Array.from({ length: 7 }, (_, index) => ({
      type: "vehicle",
      action: "create",
      entityId: randomUUID(),
      description: `Atividade ${index}`,
      status: "Completo",
      businessId: CARRIER,
      performedBy: ADMIN,
      visibilityLevel: "COMPANY",
      performingUserRole: "BUSINESS_ADMIN",
      created_at: new Date(base + index * 60_000),
    })),
  });
}, 180_000);

afterAll(async () => {
  await prisma.activity.deleteMany({ where: { businessId: CARRIER } });
  await prisma.user.deleteMany({ where: { id: { in: [ADMIN, MASTER] } } });
  await prisma.business.deleteMany({ where: { id: CARRIER } });

  await prisma.$disconnect();
  await counted.$disconnect();
});

describe("the dashboard's recent activity", () => {
  it("shows the five newest rows of the company without counting the trail", async () => {
    const overview = await overviewFor(ADMIN);

    expect(overview.recentActivity.map((row: any) => row.description)).toEqual([
      "Atividade 6",
      "Atividade 5",
      "Atividade 4",
      "Atividade 3",
      "Atividade 2",
    ]);

    expect(activityCounts()).toEqual([]);
  });

  it("does not count the whole table for a MASTER, who has no tenant", async () => {
    const overview = await overviewFor(MASTER);

    expect(overview.recentActivity).toHaveLength(5);
    expect(overview.recentActivity[0].description).toBe("Atividade 6");

    expect(activityCounts()).toEqual([]);
  });
});
