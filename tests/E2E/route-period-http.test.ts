import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { sign } from "jsonwebtoken";

import { randomUUID } from "node:crypto";

import auth from "@/config/auth";
import { createPrismaClient } from "@/shared/database/database-client";
import {
  businessDateKey,
  dateOnlyFromKey,
  shiftDateKey,
} from "@/shared/time/business-day";

/**
 * The period of the routes (plan of 09/11/2026), over real HTTP and Postgres:
 * the Rotas list and the Torre's board by route read Hoje / 7 / 14 / 30 dias
 * / Personalizado on the route's DAY, in the company's zone.
 *
 * - `period=today` lists the company's day, every route still running from
 *   an earlier one (a route left open never leaves the screen) and every
 *   route of an earlier day that never left (PLANNED or RELEASED); the pager
 *   and the cards count the same set, and the page goes by the route's day.
 *   No period = every date, newest created first.
 * - a custom range reads past or future days by the route's day, without
 *   today's running routes unless it reaches today.
 * - the route's exact number or whole id finds it on any day
 *   (`searchMeta.period.applied = false`), in the caller's company and scope.
 * - the 400s are Entregas' own texts; `day` and `period` together is a 400.
 * - the board answers `data.period` (declared, or the serializer strips it),
 *   and opens on Hoje exactly as before: never the overdue routes.
 *
 * The company is in Rio Branco (UTC-5): from 19:00 there the server's UTC
 * calendar is already on the next day, and a "today" taken from it would
 * show tomorrow's route.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018fe300-0000-7000-8000-00000000000a";
const OTHER = "018fe300-0000-7000-8000-00000000000b";

const ANA = "018fe300-0000-7000-8000-0000000000d1";
const BRUNO = "018fe300-0000-7000-8000-0000000000d2";
const FOREIGN_DRIVER = "018fe300-0000-7000-8000-0000000000d9";

const ZONE = "America/Rio_Branco";

const ROUTE = (code: number) =>
  `018fe300-0000-7000-8000-${String(code).padStart(12, "0")}`;

const tokens: Record<
  "admin" | "driverBruno" | "otherAdmin" | "master",
  string
> = {} as never;

/** The company's today, as the API resolves it, and days around it. */
const TODAY = businessDateKey(new Date(), ZONE);
const DAY = (offset: number) => shiftDateKey(TODAY, offset);

let cnpjSeq = 0;

async function seedBusiness(id: string): Promise<void> {
  cnpjSeq += 1;

  await prisma.business.create({
    data: {
      id,
      corporate_reason: `Transportadora ${id.slice(-1)}`,
      cep: "69900000",
      city: "Rio Branco",
      uf: "AC",
      street: "Rua das Transportadoras",
      address_number: "1",
      cnpj: String(41333666000180 + cnpjSeq),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "68999999999",
      email: `${id}@exemplo.com.br`,
      timezone: ZONE,
    },
  });

  await prisma.businessEntitlement.create({
    data: { businessId: id, module: "DELIVERIES", enabled: true },
  });
}

async function seedUser(
  role: "MASTER" | "BUSINESS_ADMIN" | "BUSINESS_USER",
  businessId: string | null,
  extra: { driverId?: string } = {},
): Promise<string> {
  const id = randomUUID();
  const familyId = randomUUID();

  await prisma.user.create({
    data: {
      id,
      name: "Usuário",
      email: `${id}@exemplo.com.br`,
      password: "not-used-here",
      role,
      businessId,
      driverId: extra.driverId ?? null,
    },
  });

  await prisma.refreshToken.create({
    data: {
      userId: id,
      token_hash: randomUUID(),
      jti: randomUUID(),
      family_id: familyId,
      expires_in: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

  return sign(
    { tokenType: "access", sessionVersion: 0, familyId },
    auth.secret_token,
    { subject: id, expiresIn: "15m" },
  );
}

async function seedDriver(
  businessId: string,
  id: string,
  name: string,
): Promise<void> {
  await prisma.driver.create({
    data: {
      id,
      name,
      birth_date: new Date("1990-01-01"),
      cnh: `${id}-cnh`,
      cpf: `${id}-cpf`,
      rg: `${id}-rg`,
      cep: "69900000",
      city: "Rio Branco",
      uf: "AC",
      street: "Rua",
      address_number: "1",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId,
    },
  });
}

type Status =
  "PLANNED" | "RELEASED" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";

interface Seed {
  code: number;
  day: number;
  status: Status;
  driverId: string;
}

const SEED: Seed[] = [
  { code: 1, day: 0, status: "PLANNED", driverId: ANA },
  // Left open three days ago: Hoje keeps it.
  { code: 2, day: -3, status: "IN_PROGRESS", driverId: BRUNO },
  { code: 3, day: -1, status: "COMPLETED", driverId: ANA },
  { code: 4, day: 1, status: "PLANNED", driverId: BRUNO },
  { code: 5, day: -40, status: "COMPLETED", driverId: ANA },
  { code: 6, day: 0, status: "CANCELLED", driverId: ANA },
  // Released two days ago and never started; planned fifty days ago and
  // forgotten. Their deliveries wait on them: the list keeps them.
  { code: 7, day: -2, status: "RELEASED", driverId: BRUNO },
  { code: 8, day: -50, status: "PLANNED", driverId: ANA },
];

async function list(
  query: string,
  token = tokens.admin,
): Promise<{
  status: number;
  meta: any;
  codes: number[];
  order: number[];
  body: string;
}> {
  const response = await app.inject({
    method: "GET",
    url: `/route/list-routes?page=1&pageSize=50${query ? `&${query}` : ""}`,
    headers: { authorization: `Bearer ${token}` },
  });

  if (response.statusCode !== 200) {
    return {
      status: response.statusCode,
      meta: null,
      codes: [],
      order: [],
      body: response.body,
    };
  }

  const [first, ...rows] = response.body
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  const order = rows.map((row: { code: number }) => row.code);

  return {
    status: 200,
    meta: first.meta,
    codes: [...order].sort((a, b) => a - b),
    order,
    body: response.body,
  };
}

async function monitoring(query: string, token = tokens.admin) {
  return app.inject({
    method: "GET",
    url: `/route/monitoring?page=1&pageSize=20${query ? `&${query}` : ""}`,
    headers: { authorization: `Bearer ${token}` },
  });
}

beforeAll(async () => {
  await seedBusiness(CARRIER);
  await seedBusiness(OTHER);

  await seedDriver(CARRIER, ANA, "Ana");
  await seedDriver(CARRIER, BRUNO, "Bruno");
  await seedDriver(OTHER, FOREIGN_DRIVER, "Motorista alheio");

  for (const entry of SEED) {
    await prisma.route.create({
      data: {
        id: ROUTE(entry.code),
        code: entry.code,
        name: `Entrega da semana ${entry.code}`,
        status: entry.status,
        scheduled_date: dateOnlyFromKey(DAY(entry.day)),
        // Created in code order, a minute apart: the order a period does
        // NOT follow.
        created_at: new Date(Date.now() - (10 - entry.code) * 60_000),
        started_at:
          entry.status === "IN_PROGRESS" || entry.status === "COMPLETED"
            ? new Date(Date.now() + entry.day * 24 * 60 * 60 * 1000)
            : null,
        businessId: CARRIER,
        driverId: entry.driverId,
      },
    });
  }

  // Another company's routes of today, numbered like these: never listed,
  // counted nor found here.
  for (const [code, status] of [
    [1, "IN_PROGRESS"],
    [5, "PLANNED"],
  ] as const) {
    await prisma.route.create({
      data: {
        code,
        status,
        scheduled_date: dateOnlyFromKey(TODAY),
        businessId: OTHER,
        driverId: FOREIGN_DRIVER,
      },
    });
  }

  tokens.admin = await seedUser("BUSINESS_ADMIN", CARRIER);
  tokens.driverBruno = await seedUser("BUSINESS_USER", CARRIER, {
    driverId: BRUNO,
  });
  tokens.otherAdmin = await seedUser("BUSINESS_ADMIN", OTHER);
  tokens.master = await seedUser("MASTER", null);

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

describe("the routes list by period", () => {
  it("lists the company's day with period=today, the unfinished routes of earlier days included, and counts only them", async () => {
    const { status, meta, codes, body } = await list("period=today");

    expect(status, body).toBe(200);
    expect(codes).toEqual([1, 2, 6, 7, 8]);
    expect(meta.total).toBe(5);
    expect(meta.searchMeta.statusCounts).toEqual({
      PLANNED: 2,
      RELEASED: 1,
      IN_PROGRESS: 1,
      COMPLETED: 0,
      CANCELLED: 1,
    });
    expect(meta.searchMeta.period).toEqual({
      from: TODAY,
      to: TODAY,
      applied: true,
    });
  });

  it("lists every date without a period, as every caller before it expects", async () => {
    const { meta, codes, order } = await list("");

    expect(codes).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(meta.searchMeta.period).toBeNull();
    // Newest created first, as before the period.
    expect(order).toEqual([8, 7, 6, 5, 4, 3, 2, 1]);
  });

  it("orders a period by the route's day, the latest created first within it", async () => {
    // 1 and 6 are today's (6 created later), 7 of two days ago, 2 of three,
    // 8 of fifty.
    expect((await list("period=today")).order).toEqual([6, 1, 7, 2, 8]);

    // An order asked for is kept.
    expect(
      (await list("period=today&sort=created_at&order=desc")).order,
    ).toEqual([8, 7, 6, 2, 1]);
  });

  it("widens to the last seven days of the company", async () => {
    const { meta, codes } = await list("period=7d");

    // Fifty days ago is before the week, and still waits on its deliveries.
    expect(codes).toEqual([1, 2, 3, 6, 7, 8]);
    expect(meta.searchMeta.period).toEqual({
      from: DAY(-6),
      to: TODAY,
      applied: true,
    });
  });

  it("reads a custom range by the route's day, in the past or the future", async () => {
    expect(
      (await list(`period=custom&from=${DAY(1)}&to=${DAY(1)}`)).codes,
    ).toEqual([4]);
    expect(
      (await list(`period=custom&from=${DAY(-45)}&to=${DAY(-35)}`)).codes,
    ).toEqual([5]);

    // Yesterday only: neither the route running since three days ago nor
    // the one released two days ago is of it.
    expect(
      (await list(`period=custom&from=${DAY(-1)}&to=${DAY(-1)}`)).codes,
    ).toEqual([3]);
    expect(
      (await list(`period=custom&from=${DAY(-55)}&to=${DAY(-45)}`)).codes,
    ).toEqual([8]);
  });

  it("keeps a driver user to their own routes inside the period", async () => {
    const { codes } = await list("period=today", tokens.driverBruno);

    expect(codes).toEqual([2, 7]);
  });
});

describe("a search that names one route", () => {
  it("finds the route of 40 days ago by its number or whole id, with the period set aside", async () => {
    for (const search of ["Rota%205", "%235", ROUTE(5)]) {
      const { meta, codes, body } = await list(`period=today&search=${search}`);

      expect(codes, `${search}: ${body}`).toEqual([5]);
      expect(meta.searchMeta.period.applied).toBe(false);
    }
  });

  it("keeps a partial term inside the period", async () => {
    const { meta, codes } = await list("period=today&search=semana");

    expect(codes).toEqual([1, 2, 6, 7, 8]);
    expect(meta.searchMeta.period.applied).toBe(true);
  });

  it("never reaches another driver's route, nor another company's", async () => {
    // Route 5 is Ana's: Bruno's search stays in his period and his routes.
    const bruno = await list(
      "period=today&search=Rota%205",
      tokens.driverBruno,
    );

    expect(bruno.codes).toEqual([]);
    expect(bruno.meta.searchMeta.period.applied).toBe(true);

    // The other company's own route 5 is today's; ours is never theirs.
    const theirs = await list(
      "period=today&search=Rota%205",
      tokens.otherAdmin,
    );

    expect(theirs.codes).toEqual([5]);
    expect(theirs.body).not.toContain(ROUTE(5));
  });
});

describe("the period never crosses a company", () => {
  it("lists only the caller's company, and refuses naming another", async () => {
    const theirs = await list("period=today", tokens.otherAdmin);

    expect(theirs.codes).toEqual([1, 5]);
    expect(theirs.body).not.toContain(CARRIER);

    expect(
      (await list(`period=today&businessId=${CARRIER}`, tokens.otherAdmin))
        .status,
    ).toBe(403);

    const noCompany = await list("period=today", tokens.master);

    expect(noCompany.status).toBe(400);
    expect(noCompany.body).toContain("BUSINESS_NOT_IDENTIFIED");

    const named = await list(
      `period=today&businessId=${CARRIER}`,
      tokens.master,
    );

    expect(named.codes).toEqual([1, 2, 6, 7, 8]);
  });
});

describe("the period's refusals, in Entregas' words", () => {
  it.each([
    [
      "period=custom&from=2026-01-01&to=2026-06-30",
      "O período personalizado pode ter no máximo 92 dias.",
    ],
    [
      "period=custom&from=2026-06-30&to=2026-06-01",
      "A data inicial do período não pode ser depois da data final.",
    ],
    [
      "period=7d&from=2026-06-01",
      "As datas do período (from e to) só valem com period=custom.",
    ],
    ["period=ontem", "Período inválido."],
  ])("refuses %s on both screens", async (query, text) => {
    const listed = await list(query);

    expect(listed.status).toBe(400);
    expect(listed.body).toContain(text);
    // No export to point at: the routes have none.
    expect(listed.body).not.toContain("exporte por partes");

    const board = await monitoring(query);

    expect(board.statusCode).toBe(400);
    expect(board.body).toContain(text);
  });
});

describe("the tower's board by period", () => {
  const codesOf = (body: string) =>
    (JSON.parse(body).data.routes as Array<{ code: number }>).map(
      (route) => route.code,
    );

  it("answers without a period exactly as before, with period null", async () => {
    const response = await monitoring("");

    expect(response.statusCode, response.body).toBe(200);
    // Running first, then planned; never the cancelled one, nor the
    // earlier days' routes that never left (the list's, not the board's).
    expect(codesOf(response.body)).toEqual([2, 1]);
    expect(JSON.parse(response.body).data.day).toBe(TODAY);
    expect(JSON.parse(response.body).data.period).toBeNull();
  });

  it("reads Hoje as the board without a period, and says the period", async () => {
    const response = await monitoring("period=today");

    expect(response.statusCode, response.body).toBe(200);
    expect(codesOf(response.body)).toEqual([2, 1]);
    expect(JSON.parse(response.body).data.period).toEqual({
      from: TODAY,
      to: TODAY,
    });
  });

  it("reads seven days and a past range by the route's day", async () => {
    const week = await monitoring("period=7d");

    // The released route of two days ago is of the week; the one planned
    // fifty days ago is not the board's.
    expect(codesOf(week.body)).toEqual([2, 7, 1, 3]);
    expect(JSON.parse(week.body).data.day).toBe(TODAY);

    const past = await monitoring(
      `period=custom&from=${DAY(-45)}&to=${DAY(-35)}`,
    );

    expect(codesOf(past.body)).toEqual([5]);
  });

  it("keeps the legacy day, and refuses it beside a period", async () => {
    const yesterday = await monitoring(`day=${DAY(-1)}`);

    expect(codesOf(yesterday.body)).toEqual([3]);
    expect(JSON.parse(yesterday.body).data.period).toBeNull();

    const both = await monitoring(`day=${DAY(-1)}&period=7d`);

    expect(both.statusCode).toBe(400);
    expect(both.body).toContain("Envie day ou period, não os dois.");
  });

  it("never shows another company's board", async () => {
    const named = await monitoring(
      `period=30d&businessId=${CARRIER}`,
      tokens.otherAdmin,
    );

    expect(named.statusCode).toBe(403);

    const own = await monitoring("period=30d", tokens.otherAdmin);

    expect(codesOf(own.body)).toEqual([1, 5]);
    expect(own.body).not.toContain(CARRIER);
  });
});
