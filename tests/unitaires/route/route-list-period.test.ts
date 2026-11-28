import { describe, expect, it } from "vitest";

import { ListRoutesUseCase } from "@/modules/route/usecases/list-routes/list-routes-usecase";
import {
  routeListPeriodSpan,
  routeListUnfinishedWhere,
  routeListWhere,
} from "@/modules/route/usecases/list-routes/route-list";
import { InMemoryRouteRepository } from "@/modules/route/repositories/in-memory/in-memory-route-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";
import { BUSINESS_COLUMN_DEFAULTS } from "@/shared/in-memory/column-defaults";
import { listRoutesSchema } from "@/schemas/route-schema";

import type { User } from "@/modules/user/dtos/user-dto";
import type { Business } from "@/modules/business/dtos/business-dto";
import type { RouteStatus } from "@/shared/route/route-rules";

/**
 * The routes list by period (plan of 09/11/2026): Hoje / 7 / 14 / 30 dias /
 * Personalizado, like Entregas, read on the route's DAY in the company's
 * zone — and a route forgotten "Em andamento" never leaves Hoje.
 *
 * The company is in Rio Branco (UTC-5) and the clock is 03:30 UTC of
 * 09/11/2026: 22:30 of the 8th there. A route of the 9th is tomorrow's for
 * the company, whatever the server's calendar says.
 */
const CARRIER = "018f0000-0000-7000-8000-00000000d0a1";
const OTHER = "018f0000-0000-7000-8000-00000000d0a2";

const MANAGER = "018f0000-0000-7000-8000-00000000d1a1";
const DRIVER_USER = "018f0000-0000-7000-8000-00000000d1a2";
const MASTER = "018f0000-0000-7000-8000-00000000d1a3";

const ANA = "018f0000-0000-7000-8000-00000000d2a1";
const BRUNO = "018f0000-0000-7000-8000-00000000d2a2";
const FOREIGN_DRIVER = "018f0000-0000-7000-8000-00000000d2a3";

const NOW = new Date("2026-11-09T03:30:00.000Z");

interface Seed {
  code: number;
  day: string;
  status: RouteStatus;
  driverId: string;
}

const SEED: Seed[] = [
  { code: 1, day: "2026-11-08", status: "PLANNED", driverId: ANA },
  // Left open three days ago: Hoje keeps it.
  { code: 2, day: "2026-11-05", status: "IN_PROGRESS", driverId: BRUNO },
  { code: 3, day: "2026-11-07", status: "COMPLETED", driverId: ANA },
  // The UTC day of the clock, tomorrow for the company.
  { code: 4, day: "2026-11-09", status: "PLANNED", driverId: BRUNO },
  { code: 5, day: "2026-10-09", status: "COMPLETED", driverId: ANA },
  { code: 6, day: "2026-11-08", status: "IN_PROGRESS", driverId: ANA },
];

const idOf = (code: number) =>
  `018f0000-0000-7000-8000-${String(code).padStart(12, "0")}`;

async function build(extra: Seed[] = []) {
  const users = new InMemoryUserRepository();
  const businesses = new InMemoryBusinessRepository();
  const routes = new InMemoryRouteRepository(
    [],
    [],
    [
      { id: ANA, businessId: CARRIER, name: "Ana", status: "ACTIVE" },
      { id: BRUNO, businessId: CARRIER, name: "Bruno", status: "ACTIVE" },
      {
        id: FOREIGN_DRIVER,
        businessId: OTHER,
        name: "Motorista alheio",
        status: "ACTIVE",
      },
    ],
  );

  users.user.push(
    { id: MANAGER, role: "BUSINESS_ADMIN", businessId: CARRIER } as User,
    {
      id: DRIVER_USER,
      role: "BUSINESS_USER",
      businessId: CARRIER,
      driverId: BRUNO,
    } as User,
    { id: MASTER, role: "MASTER", businessId: null } as unknown as User,
  );

  businesses.business.push(
    {
      ...BUSINESS_COLUMN_DEFAULTS,
      id: CARRIER,
      is_active: true,
      timezone: "America/Rio_Branco",
    } as Business,
    {
      ...BUSINESS_COLUMN_DEFAULTS,
      id: OTHER,
      is_active: true,
      timezone: "America/Sao_Paulo",
    } as Business,
  );

  for (const entry of [...SEED, ...extra]) {
    const created = await routes.createRoute({
      businessId: CARRIER,
      driverId: entry.driverId,
      scheduled_date: new Date(`${entry.day}T00:00:00.000Z`),
      deliveryIds: [],
    });

    Object.assign(
      routes.routes.find((route) => route.id === created.id)!,
      {
        id: idOf(entry.code),
        code: entry.code,
        status: entry.status,
        created_at: new Date(NOW.getTime() - (10 - entry.code) * 60_000),
      },
    );
  }

  // Another company's routes of the same days, numbered like these.
  for (const code of [1, 2, 5]) {
    const created = await routes.createRoute({
      businessId: OTHER,
      driverId: FOREIGN_DRIVER,
      scheduled_date: new Date("2026-11-08T00:00:00.000Z"),
      deliveryIds: [],
    });

    Object.assign(
      routes.routes.find((route) => route.id === created.id)!,
      { code, status: "IN_PROGRESS" },
    );
  }

  const useCase = new ListRoutesUseCase(routes, users, businesses);

  const list = (
    query: Partial<Parameters<ListRoutesUseCase["execute"]>[0]> = {},
  ) =>
    useCase.execute({
      userId: MANAGER,
      page: 1,
      pageSize: 50,
      now: NOW,
      ...query,
    });

  return { list, useCase };
}

const codes = (result: { data: Array<{ code: number }> }) =>
  result.data.map((route) => route.code).sort((a, b) => a - b);

describe("the routes list by period", () => {
  it("opens Hoje on the company's day, with the routes still running from before", async () => {
    const { list } = await build();

    const today = await list({ period: "today" });

    // Not yesterday's completed route, nor the 9th's (tomorrow there), nor
    // last month's; the route left open on the 5th stays.
    expect(codes(today)).toEqual([1, 2, 6]);
    expect(today.meta.period).toEqual({
      from: "2026-11-08",
      to: "2026-11-08",
      applied: true,
    });
  });

  it("counts the cards and the filter options in the period", async () => {
    const { list } = await build();

    const today = await list({ period: "today" });

    expect(today.total).toBe(3);
    expect(today.meta.statusCounts).toEqual({
      PLANNED: 1,
      RELEASED: 0,
      IN_PROGRESS: 2,
      COMPLETED: 0,
      CANCELLED: 0,
    });
    expect(today.meta.facets.driverId).toEqual([
      { value: ANA, label: "Ana", count: 2 },
      { value: BRUNO, label: "Bruno", count: 1 },
    ]);

    // A status chosen narrows the page, not the period's other cards.
    const running = await list({ period: "today", statuses: ["IN_PROGRESS"] });

    expect(codes(running)).toEqual([2, 6]);
    expect(running.meta.statusCounts.PLANNED).toBe(1);
  });

  it("widens to the last seven days of the company", async () => {
    const { list } = await build();

    const week = await list({ period: "7d" });

    expect(codes(week)).toEqual([1, 2, 3, 6]);
    expect(week.meta.period).toEqual({
      from: "2026-11-02",
      to: "2026-11-08",
      applied: true,
    });
  });

  it("reads a past custom range by the route's day, without today's running routes", async () => {
    const { list } = await build();

    const october = await list({
      period: "custom",
      from: "2026-10-01",
      to: "2026-10-31",
    });

    expect(codes(october)).toEqual([5]);
  });

  it("reads a future custom day: tomorrow's planned route", async () => {
    const { list } = await build();

    const tomorrow = await list({
      period: "custom",
      from: "2026-11-09",
      to: "2026-11-09",
    });

    expect(codes(tomorrow)).toEqual([4]);
  });

  it("lists every date without a period, as before it", async () => {
    const { list } = await build();

    const all = await list();

    expect(codes(all)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(all.meta.period).toBeNull();
    expect(all.meta.timeZone).toBe("America/Rio_Branco");
  });
});

describe("a route of an earlier day that never left", () => {
  // Released on the 3rd and never started, planned for September and
  // forgotten, cancelled on the 4th.
  const OVERDUE: Seed[] = [
    { code: 7, day: "2026-11-03", status: "RELEASED", driverId: BRUNO },
    { code: 8, day: "2026-11-04", status: "CANCELLED", driverId: ANA },
    { code: 9, day: "2026-09-01", status: "PLANNED", driverId: ANA },
  ];

  it("stays on Hoje and in every preset, and counts on the cards", async () => {
    const { list } = await build(OVERDUE);

    const today = await list({ period: "today" });

    // Not the cancelled one: nothing waits on it.
    expect(codes(today)).toEqual([1, 2, 6, 7, 9]);
    expect(today.total).toBe(5);
    expect(today.meta.statusCounts).toMatchObject({
      PLANNED: 2,
      RELEASED: 1,
      IN_PROGRESS: 2,
      CANCELLED: 0,
    });

    // The 4th is in the week; September is before it, and still kept.
    expect(codes(await list({ period: "7d" }))).toEqual([1, 2, 3, 6, 7, 8, 9]);
  });

  it("is its own day's in a past range, and no other's", async () => {
    const { list } = await build(OVERDUE);

    expect(
      codes(
        await list({ period: "custom", from: "2026-10-01", to: "2026-10-31" }),
      ),
    ).toEqual([5]);
    expect(
      codes(
        await list({ period: "custom", from: "2026-09-01", to: "2026-09-01" }),
      ),
    ).toEqual([9]);
  });

  it("stays the driver's own for a driver user", async () => {
    const { list } = await build(OVERDUE);

    expect(codes(await list({ userId: DRIVER_USER, period: "today" }))).toEqual(
      [2, 7],
    );
  });
});

describe("the order of the list", () => {
  const order = (result: { data: Array<{ code: number }> }) =>
    result.data.map((route) => route.code);

  const OVERDUE: Seed[] = [
    { code: 7, day: "2026-11-03", status: "RELEASED", driverId: BRUNO },
    { code: 9, day: "2026-09-01", status: "PLANNED", driverId: ANA },
  ];

  it("goes by the route's day with a period, the latest created first within it", async () => {
    const { list } = await build(OVERDUE);

    // Created in code order: by creation it would read 9, 7, 6, 2, 1.
    expect(order(await list({ period: "today" }))).toEqual([6, 1, 2, 7, 9]);
  });

  it("keeps newest created first without a period, and any order asked for", async () => {
    const { list } = await build(OVERDUE);

    expect(order(await list())).toEqual([9, 7, 6, 5, 4, 3, 2, 1]);
    expect(
      order(await list({ period: "today", sort: "created_at", order: "desc" })),
    ).toEqual([9, 7, 6, 2, 1]);
    expect(
      order(
        await list({ period: "today", sort: "scheduled_date", order: "asc" }),
      ),
    ).toEqual([9, 7, 2, 6, 1]);
  });
});

describe("a search that names one route", () => {
  it("finds last month's route by its number or whole id, whatever the period", async () => {
    const { list } = await build();

    for (const search of ["Rota 5", "#5", "5", idOf(5)]) {
      const found = await list({ period: "today", search });

      expect(codes(found), search).toEqual([5]);
      expect(found.meta.period, search).toEqual({
        from: "2026-11-08",
        to: "2026-11-08",
        applied: false,
      });
    }
  });

  it("keeps the period for a partial term and for an id's tail", async () => {
    const { list } = await build();

    const tail = await list({ period: "today", search: idOf(5).slice(-12) });

    expect(codes(tail)).toEqual([]);
    expect(tail.meta.period?.applied).toBe(true);

    const missing = await list({ period: "today", search: "Rota 99" });

    expect(codes(missing)).toEqual([]);
    expect(missing.meta.period?.applied).toBe(true);
  });

  it("never reaches another driver's route for a driver user", async () => {
    const { list } = await build();

    // Route 5 is Ana's; the driver user is Bruno.
    const asBruno = await list({
      userId: DRIVER_USER,
      period: "today",
      search: "Rota 5",
    });

    expect(codes(asBruno)).toEqual([]);
    expect(asBruno.meta.period?.applied).toBe(true);
  });
});

describe("the period never crosses a company", () => {
  it("lists and counts only the company's routes", async () => {
    const { list } = await build();

    const today = await list({ period: "today" });

    expect(today.data.every((route) => route.businessId === CARRIER)).toBe(
      true,
    );

    // The other company's route 1 is running today too; "Rota 1" finds ours.
    const one = await list({ period: "7d", search: "Rota 1" });

    expect(one.data.map((route) => route.id)).toEqual([idOf(1)]);
  });

  it("refuses a manager naming another company, and asks a master which one", async () => {
    const { list } = await build();

    await expect(
      list({ businessId: OTHER, period: "today" }),
    ).rejects.toMatchObject({ statusCode: 403 });

    await expect(
      list({ userId: MASTER, period: "today" }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "BUSINESS_NOT_IDENTIFIED",
    });

    const named = await list({
      userId: MASTER,
      businessId: CARRIER,
      period: "today",
    });

    expect(codes(named)).toEqual([1, 2, 6]);
  });
});

describe("the list's query", () => {
  it("takes the period, and refuses what Entregas refuses, without the export's advice", () => {
    expect(
      listRoutesSchema.safeParse({ page: "1", pageSize: "10", period: "14d" })
        .success,
    ).toBe(true);

    const tooLong = listRoutesSchema.safeParse({
      page: "1",
      pageSize: "10",
      period: "custom",
      from: "2026-01-01",
      to: "2026-06-30",
    });

    expect(
      tooLong.success ? [] : tooLong.error.issues.map((issue) => issue.message),
    ).toEqual(["O período personalizado pode ter no máximo 92 dias."]);

    const loose = listRoutesSchema.safeParse({
      page: "1",
      pageSize: "10",
      from: "2026-01-01",
    });

    expect(
      loose.success ? [] : loose.error.issues.map((issue) => issue.message),
    ).toEqual(["As datas do período (from e to) só valem com period=custom."]);
  });
});

describe("the days the listing reads", () => {
  const today = {
    from: "2026-11-08",
    to: "2026-11-08",
    includesRunning: true,
    includesOverdue: true,
  };

  it("reaches back to the oldest forgotten route, and ahead to a running one of a later day", () => {
    expect(
      routeListPeriodSpan(
        today,
        new Date("2026-11-05T00:00:00.000Z"),
        new Date("2026-11-09T00:00:00.000Z"),
      ),
    ).toEqual({ from: "2026-11-05", to: "2026-11-09" });
  });

  it("stays on the period's own days with no forgotten route", () => {
    expect(routeListPeriodSpan(today, null, null)).toEqual({
      from: "2026-11-08",
      to: "2026-11-08",
    });

    // A running route of today is inside the period already.
    expect(
      routeListPeriodSpan(
        today,
        new Date("2026-11-08T00:00:00.000Z"),
        new Date("2026-11-08T00:00:00.000Z"),
      ),
    ).toEqual({ from: "2026-11-08", to: "2026-11-08" });
  });

  it("probes the company's and the driver's unfinished routes only, and nothing for a past range", () => {
    expect(
      routeListUnfinishedWhere({
        businessId: CARRIER,
        scopeDriverId: ANA,
        search: "rota",
        statuses: ["COMPLETED"],
        period: today,
      }),
    ).toEqual({
      businessId: CARRIER,
      driverId: ANA,
      OR: [
        { status: "IN_PROGRESS" },
        {
          status: { in: ["PLANNED", "RELEASED"] },
          scheduled_date: { lt: new Date("2026-11-08T00:00:00.000Z") },
        },
      ],
    });

    expect(
      routeListUnfinishedWhere({
        businessId: CARRIER,
        period: {
          from: "2026-10-01",
          to: "2026-10-07",
          includesRunning: false,
          includesOverdue: false,
        },
      }),
    ).toBeNull();

    expect(routeListUnfinishedWhere({ businessId: CARRIER })).toBeNull();
  });

  it("keeps the read inside those days without changing what it holds", () => {
    const where = routeListWhere({
      businessId: CARRIER,
      period: today,
      periodSpan: { from: "2026-11-05", to: "2026-11-09" },
    });

    expect(JSON.stringify(where)).toContain(
      JSON.stringify({
        scheduled_date: {
          gte: new Date("2026-11-05T00:00:00.000Z"),
          lte: new Date("2026-11-09T00:00:00.000Z"),
        },
      }),
    );
  });
});
