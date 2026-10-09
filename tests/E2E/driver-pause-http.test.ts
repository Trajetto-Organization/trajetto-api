import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { sign } from "jsonwebtoken";
import auth from "@/config/auth";

import {
  businessDateKey,
  shiftDateKey,
  zonedWallTimeToUtc,
} from "@/shared/time/business-day";

import { seedFleetDriver, seedUser } from "./support/fleet-driver-seed";
import { pauseTypeId } from "./support/pause-type-seed";
import { seedJourneyRoute } from "./support/journey-route-seed";

/**
 * Driver pauses through the real application and a real database (decision
 * 6.1): the app's start and end, idempotent under resends and races (the
 * unique keys and the partial one-open-pause index decide), the phone's
 * clock corrected like occurrences, what the app reads to know it is on a
 * pause, and the office report — with every guard: driver-only writes,
 * office-only report, module, tenant and MASTER.
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018fe1b0-0000-7000-8000-00000000000a";
const OTHER = "018fe1b0-0000-7000-8000-00000000000b";
const BARE = "018fe1b0-0000-7000-8000-00000000000c";

const ZONE = "America/Sao_Paulo";

const tokens: Record<string, string> = {};
const ids: Record<string, string> = {};

async function seedProfile(
  businessId: string,
  permissionKey: string,
  canWrite: boolean,
): Promise<string> {
  const profile = await prisma.profileAccess.create({
    data: {
      name: `Perfil ${randomUUID().slice(0, 8)}`,
      businessId,
      permissions: {
        create: [{ permissionKey, action: permissionKey, canRead: true, canWrite, businessId }],
      },
    },
  });

  return profile.id;
}

async function officeUser(businessId: string, profileAccessId: string): Promise<string> {
  const id = randomUUID();
  const familyId = randomUUID();

  await prisma.user.create({
    data: {
      id,
      name: "Escritório",
      email: `${id}@exemplo.com.br`,
      password: "not-used-here",
      role: "BUSINESS_USER",
      businessId,
      profileAccessId,
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

  return sign({ tokenType: "access", sessionVersion: 0, familyId }, auth.secret_token, {
    subject: id,
    expiresIn: "30m",
  });
}

async function masterToken(): Promise<string> {
  const id = randomUUID();
  const familyId = randomUUID();

  await prisma.user.create({
    data: {
      id,
      name: "Suporte",
      email: `${id}@exemplo.com.br`,
      password: "not-used-here",
      role: "MASTER",
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

  return sign({ tokenType: "access", sessionVersion: 0, familyId }, auth.secret_token, {
    subject: id,
    expiresIn: "30m",
  });
}

async function newDriver(businessId: string, name: string): Promise<{ id: string; token: string }> {
  const driver = await prisma.driver.create({
    data: {
      name,
      birth_date: new Date("1990-01-01"),
      cnh: randomUUID().replace(/-/g, "").slice(0, 11),
      cpf: randomUUID().slice(0, 14),
      rg: randomUUID().slice(0, 12),
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId,
    },
  });

  const user = await seedUser(prisma, businessId, "BUSINESS_USER", driver.id);

  // On the street, so its pauses are inside a journey (decision 14.4).
  await seedJourneyRoute(prisma, businessId, driver.id);

  return { id: driver.id, token: user.token };
}

function post(
  path: string,
  token: string,
  payload: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return app.inject({
    method: "POST",
    url: path,
    headers: { authorization: `Bearer ${token}`, ...headers },
    payload,
  });
}

function get(path: string, token: string) {
  return app.inject({
    method: "GET",
    url: path,
    headers: { authorization: `Bearer ${token}` },
  });
}

const startPath = (businessId = CARRIER) => `/driver-pause/start/${businessId}`;
const endPath = (businessId = CARRIER) => `/driver-pause/end/${businessId}`;
const currentPath = (businessId = CARRIER) => `/driver-pause/current/${businessId}`;
const reportPath = (businessId = CARRIER, query = "") =>
  `/driver-pause/report/${businessId}${query ? `?${query}` : ""}`;

const refusal = (response: { statusCode: number; json: () => { code?: string } }) =>
  `${response.statusCode} ${response.json().code}`;

beforeAll(async () => {
  const carrier = await seedFleetDriver(prisma, { businessId: CARRIER, cnpj: "11222777000101" });
  const other = await seedFleetDriver(prisma, { businessId: OTHER, cnpj: "11222777000202" });
  const bare = await seedFleetDriver(prisma, { businessId: BARE, cnpj: "11222777000303" });

  // A company that never hired Entregas.
  await prisma.businessEntitlement.deleteMany({
    where: { businessId: BARE, module: "DELIVERIES" },
  });

  ids.driver = carrier.driverId;
  ids.otherDriver = other.driverId;

  tokens.driver = carrier.driverToken;
  tokens.admin = carrier.managerToken;
  tokens.otherDriver = other.driverToken;
  tokens.otherAdmin = other.managerToken;
  tokens.bareDriver = bare.driverToken;

  const colleague = await newDriver(CARRIER, "Zeca Colega");
  ids.colleague = colleague.id;
  tokens.colleague = colleague.token;

  tokens.dispatcher = await officeUser(CARRIER, await seedProfile(CARRIER, "delivery_manage", true));
  tokens.reader = await officeUser(CARRIER, await seedProfile(CARRIER, "delivery_manage", false));
  tokens.driverReader = await officeUser(CARRIER, await seedProfile(CARRIER, "driver_manage", false));
  tokens.mechanic = await officeUser(CARRIER, await seedProfile(CARRIER, "fuel_manage", true));
  tokens.master = await masterToken();

  // Decision 14.4: pauses start only inside a journey. These drivers are on
  // the street; the journey rule itself is tested in
  // tests/E2E/occurrence-categories-http.test.ts.
  for (const [businessId, driverId] of [
    [CARRIER, ids.driver],
    [CARRIER, ids.colleague],
    [OTHER, ids.otherDriver],
  ]) {
    await seedJourneyRoute(prisma, businessId, driverId);
  }

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
}, 60_000);

describe("the driver starts and ends a pause", () => {
  const startKey = randomUUID();
  const endKey = randomUUID();

  it("starts it at the tap, on the server's clock, even with the phone two hours ahead", async () => {
    const skew = 2 * 60 * 60 * 1000;
    const phoneNow = Date.now() + skew;

    const response = await post(
      startPath(),
      tokens.driver,
      {
        kind: "MEAL",
        start_submission_id: startKey,
        occurred_at: new Date(phoneNow - 30 * 60_000).toISOString(),
        latitude: -23.55,
        longitude: -46.63,
        note: "  Almoço   no posto  ",
      },
      { "x-client-sent-at": new Date(phoneNow).toISOString() },
    );

    expect(response.statusCode).toBe(201);

    const { pause, replayed } = response.json();

    expect(replayed).toBe(false);
    expect(pause).toMatchObject({
      kind: "MEAL",
      ended_at: null,
      duration_minutes: null,
      note: "Almoço no posto",
      start_submission_id: startKey,
      start_latitude: -23.55,
    });

    const startedAgo = Date.now() - new Date(pause.started_at).getTime();

    expect(startedAgo).toBeGreaterThan(29 * 60_000);
    expect(startedAgo).toBeLessThan(31 * 60_000);

    ids.pause = pause.id;
  });

  it("answers the outbox's resend with the same pause and writes nothing", async () => {
    const response = await post(startPath(), tokens.driver, {
      kind: "MEAL",
      start_submission_id: startKey,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ replayed: true, pause: { id: ids.pause } });
    expect(await prisma.driverPause.count({ where: { driverId: ids.driver } })).toBe(1);
  });

  it("refuses a second open pause with a friendly 409", async () => {
    const response = await post(startPath(), tokens.driver, {
      kind: "REST",
      start_submission_id: randomUUID(),
    });

    expect(refusal(response)).toBe("409 PAUSE_ALREADY_OPEN");
    expect(response.json().message).toContain("Encerre-a");
  });

  it("tells the app which pause is open, with the key the end must name", async () => {
    const response = await get(currentPath(), tokens.driver);

    expect(response.statusCode).toBe(200);

    const body = response.json();

    expect(body.timeZone).toBe(ZONE);
    expect(body.day).toBe(businessDateKey(new Date(), ZONE));
    expect(body.open).toMatchObject({ id: ids.pause, start_submission_id: startKey });
  });

  it("ends it, answers the resend, and refuses a second end with another key", async () => {
    const first = await post(endPath(), tokens.driver, {
      start_submission_id: startKey,
      end_submission_id: endKey,
      occurred_at: new Date().toISOString(),
    });

    expect(first.statusCode).toBe(200);
    expect(first.json().replayed).toBe(false);
    expect(first.json().pause.ended_at).not.toBeNull();
    expect(first.json().pause.duration_minutes).toBeGreaterThanOrEqual(29);

    const resend = await post(endPath(), tokens.driver, {
      start_submission_id: startKey,
      end_submission_id: endKey,
    });

    expect(resend.statusCode).toBe(200);
    expect(resend.json()).toMatchObject({ replayed: true, pause: first.json().pause });

    const other = await post(endPath(), tokens.driver, {
      start_submission_id: startKey,
      end_submission_id: randomUUID(),
    });

    expect(refusal(other)).toBe("409 PAUSE_ALREADY_ENDED");

    const current = await get(currentPath(), tokens.driver);

    expect(current.json().open).toBeNull();

    // "Today" is the company's: a pause begun before its midnight is not in it.
    const startedToday =
      businessDateKey(new Date(first.json().pause.started_at), ZONE) === current.json().day;

    expect(current.json().today.map((pause: { id: string }) => pause.id).includes(ids.pause)).toBe(
      startedToday,
    );
  });

  it("takes an end that arrives before its start, and the late start finds the closed pause", async () => {
    const lateStart = randomUUID();
    const tapped = Date.now() - 50 * 60_000;

    const ended = await post(endPath(), tokens.driver, {
      start_submission_id: lateStart,
      end_submission_id: randomUUID(),
      occurred_at: new Date(tapped + 20 * 60_000).toISOString(),
      start: { kind: "REST", occurred_at: new Date(tapped).toISOString() },
    });

    expect(ended.statusCode).toBe(200);
    expect(ended.json().pause).toMatchObject({ kind: "REST", duration_minutes: 20 });

    const started = await post(startPath(), tokens.driver, {
      kind: "REST",
      start_submission_id: lateStart,
      occurred_at: new Date(tapped).toISOString(),
    });

    expect(started.statusCode).toBe(200);
    expect(started.json()).toMatchObject({ replayed: true, pause: { id: ended.json().pause.id } });
  });

  it("answers an end with no start anywhere with 404", async () => {
    const response = await post(endPath(), tokens.driver, {
      start_submission_id: randomUUID(),
      end_submission_id: randomUUID(),
    });

    expect(refusal(response)).toBe("404 PAUSE_NOT_FOUND");
  });

  it("refuses a start tapped beyond the offline horizon, and the end that would create it", async () => {
    // Dated by its arrival, it opened NOW a pause the driver never began.
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60_000).toISOString();
    const startKey = randomUUID();

    const started = await post(
      startPath(),
      tokens.colleague,
      { kind: "OTHER", start_submission_id: startKey, occurred_at: tenDaysAgo },
      { "x-client-sent-at": new Date().toISOString() },
    );

    expect(refusal(started)).toBe("409 PAUSE_TOO_OLD");

    const ended = await post(endPath(), tokens.colleague, {
      start_submission_id: startKey,
      end_submission_id: randomUUID(),
      occurred_at: new Date().toISOString(),
      start: { kind: "OTHER", occurred_at: tenDaysAgo },
    });

    expect(refusal(ended)).toBe("409 PAUSE_TOO_OLD");
    expect(await prisma.driverPause.count({ where: { driverId: ids.colleague } })).toBe(0);

    // The slot stays free for the driver's real pause.
    const real = await post(startPath(), tokens.colleague, {
      kind: "REST",
      start_submission_id: randomUUID(),
    });

    expect(real.statusCode).toBe(201);

    await post(endPath(), tokens.colleague, {
      start_submission_id: real.json().pause.start_submission_id,
      end_submission_id: randomUUID(),
    });
  });

  it("closes a pause that exists with a stale end at its arrival, freeing the slot", async () => {
    const closer = await newDriver(CARRIER, "Fim Atrasado");
    const key = randomUUID();

    await post(startPath(), closer.token, { kind: "MEAL", start_submission_id: key });

    const ended = await post(endPath(), closer.token, {
      start_submission_id: key,
      end_submission_id: randomUUID(),
      occurred_at: new Date(Date.now() - 9 * 24 * 60 * 60_000).toISOString(),
    });

    expect(ended.statusCode).toBe(200);
    expect(Date.now() - new Date(ended.json().pause.ended_at).getTime()).toBeLessThan(60_000);
    expect(
      (await post(startPath(), closer.token, { kind: "REST", start_submission_id: randomUUID() }))
        .statusCode,
    ).toBe(201);
  });

  it("refuses a malformed body as a contract error", async () => {
    expect(
      refusal(
        await post(startPath(), tokens.driver, { kind: "LUNCH", start_submission_id: randomUUID() }),
      ),
    ).toBe("400 VALIDATION_ERROR");

    expect(
      refusal(
        await post(startPath(), tokens.driver, {
          kind: "MEAL",
          start_submission_id: randomUUID(),
          note: "x".repeat(201),
        }),
      ),
    ).toBe("400 VALIDATION_ERROR");
  });
});

describe("races", () => {
  it("lets exactly one of two starts with different keys open a pause", async () => {
    const racer = await newDriver(CARRIER, "Corrida Um");

    const responses = await Promise.all(
      [randomUUID(), randomUUID()].map((key) =>
        post(startPath(), racer.token, { kind: "MEAL", start_submission_id: key }),
      ),
    );

    expect(responses.map(refusal).map((line) => line.split(" ")[0]).sort()).toEqual([
      "201",
      "409",
    ]);
    expect(responses.map(refusal)).toContain("409 PAUSE_ALREADY_OPEN");
    expect(await prisma.driverPause.count({ where: { driverId: racer.id, ended_at: null } })).toBe(1);
  });

  it("writes one pause for the same start sent twice at once", async () => {
    const racer = await newDriver(CARRIER, "Corrida Dois");
    const key = randomUUID();

    const responses = await Promise.all(
      [1, 2].map(() => post(startPath(), racer.token, { kind: "REST", start_submission_id: key })),
    );

    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 201]);
    expect(new Set(responses.map((response) => response.json().pause.id)).size).toBe(1);
    expect(await prisma.driverPause.count({ where: { driverId: racer.id } })).toBe(1);
  });

  it("closes a pause once when two ends with different keys race", async () => {
    const racer = await newDriver(CARRIER, "Corrida Três");
    const key = randomUUID();

    await post(startPath(), racer.token, { kind: "MEAL", start_submission_id: key });

    const responses = await Promise.all(
      [randomUUID(), randomUUID()].map((endKey) =>
        post(endPath(), racer.token, { start_submission_id: key, end_submission_id: endKey }),
      ),
    );

    expect(responses.map(refusal).sort()).toEqual(["200 undefined", "409 PAUSE_ALREADY_ENDED"]);
  });
});

describe("who may write and read pauses", () => {
  it("writes only as the driver", async () => {
    for (const token of [tokens.admin, tokens.dispatcher, tokens.master]) {
      expect(
        refusal(await post(startPath(), token, { kind: "MEAL", start_submission_id: randomUUID() })),
      ).toBe("403 PERMISSION_DENIED");
    }

    expect(refusal(await get(currentPath(), tokens.admin))).toBe("403 PERMISSION_DENIED");
  });

  it("refuses another company's driver and a company without Entregas", async () => {
    expect(
      refusal(
        await post(startPath(CARRIER), tokens.otherDriver, {
          kind: "MEAL",
          start_submission_id: randomUUID(),
        }),
      ),
    ).toBe("403 TENANT_ACCESS_DENIED");

    expect(refusal(await get(currentPath(CARRIER), tokens.otherDriver))).toBe(
      "403 TENANT_ACCESS_DENIED",
    );

    expect(
      refusal(
        await post(startPath(BARE), tokens.bareDriver, {
          kind: "MEAL",
          start_submission_id: randomUUID(),
        }),
      ),
    ).toBe("403 MODULE_NOT_ENABLED");
  });

  it("never hands a driver another driver's pause on a guessed key", async () => {
    const key = randomUUID();

    await post(startPath(), tokens.colleague, { kind: "REST", start_submission_id: key });

    expect(
      refusal(await post(startPath(), tokens.driver, { kind: "REST", start_submission_id: key })),
    ).toBe("409 SUBMISSION_OWNER_MISMATCH");

    expect(
      refusal(
        await post(endPath(), tokens.driver, {
          start_submission_id: key,
          end_submission_id: randomUUID(),
        }),
      ),
    ).toBe("409 SUBMISSION_OWNER_MISMATCH");

    await post(endPath(), tokens.colleague, {
      start_submission_id: key,
      end_submission_id: randomUUID(),
    });
  });

  it("opens the report to the office that follows deliveries, never to a driver", async () => {
    expect((await get(reportPath(), tokens.admin)).statusCode).toBe(200);
    expect((await get(reportPath(), tokens.reader)).statusCode).toBe(200);

    // The one screen that shows it asks for delivery_manage (decision 4.2):
    // a drivers-only profile reaching the API but never the page was a gap.
    expect(refusal(await get(reportPath(), tokens.driverReader))).toBe("403 PERMISSION_DENIED");

    expect(refusal(await get(reportPath(), tokens.driver))).toBe("403 PERMISSION_DENIED");
    expect(refusal(await get(reportPath(), tokens.mechanic))).toBe("403 PERMISSION_DENIED");
    expect(refusal(await get(reportPath(CARRIER), tokens.otherAdmin))).toBe(
      "403 TENANT_ACCESS_DENIED",
    );
  });

  it("lets the MASTER read a company's report, behind the module gate", async () => {
    expect((await get(reportPath(CARRIER), tokens.master)).statusCode).toBe(200);
    expect(refusal(await get(reportPath(BARE), tokens.master))).toBe("403 MODULE_NOT_ENABLED");
    expect(refusal(await get(reportPath(randomUUID()), tokens.master))).toBe(
      "404 TENANT_NOT_FOUND",
    );
  });
});

describe("the office report", () => {
  const today = businessDateKey(new Date(), ZONE);
  const yesterday = shiftDateKey(today, -1);

  /** A wall time of yesterday in São Paulo. */
  const wall = (hour: number, minute = 0) => {
    const [year, month, day] = yesterday.split("-").map(Number);

    return zonedWallTimeToUtc(ZONE, year, month, day, hour, minute);
  };

  let reportDriver = "";

  beforeAll(async () => {
    const driver = await newDriver(CARRIER, "Ana Relatório");
    reportDriver = driver.id;

    await prisma.route.create({
      data: {
        code: 900,
        status: "COMPLETED",
        scheduled_date: new Date(`${yesterday}T00:00:00.000Z`),
        started_at: wall(7),
        completed_at: wall(15),
        businessId: CARRIER,
        driverId: driver.id,
      },
    });

    await prisma.driverPause.create({
      data: {
        kind: "MEAL",
        started_at: wall(11),
        ended_at: wall(11, 40),
        start_submission_id: randomUUID(),
        end_submission_id: randomUUID(),
        businessId: CARRIER,
        driverId: driver.id,
        occurrenceTypeId: await pauseTypeId(prisma, CARRIER, "MEAL"),
      },
    });

    // Another company's day, on the same yesterday: must never show up.
    await prisma.driverPause.create({
      data: {
        kind: "MEAL",
        started_at: wall(11),
        ended_at: wall(12),
        start_submission_id: randomUUID(),
        end_submission_id: randomUUID(),
        businessId: OTHER,
        driverId: ids.otherDriver,
        occurrenceTypeId: await pauseTypeId(prisma, OTHER, "MEAL"),
      },
    });
  });

  it("gives the driver's day with the Lei 13.103 alerts, in the company's zone", async () => {
    const response = await get(
      reportPath(CARRIER, `from=${yesterday}&to=${yesterday}&driverId=${reportDriver}`),
      tokens.reader,
    );

    expect(response.statusCode).toBe(200);

    const body = response.json();

    expect(body).toMatchObject({ timeZone: ZONE, from: yesterday, to: yesterday, total: 1 });
    expect(body.rules.interjornadaMinutes).toBe(660);

    const [row] = body.data;

    expect(row).toMatchObject({
      id: `${reportDriver}:${yesterday}`,
      day: yesterday,
      driverName: "Ana Relatório",
      inProgress: false,
      workday: { minutes: 480 },
      totals: {
        pauseMinutes: 40,
        mealMinutes: 40,
        longestMealMinutes: 40,
        drivingMinutes: 440,
        longestDrivingWithoutRestMinutes: 240,
      },
    });
    expect(row.flags.map((flag: { code: string }) => flag.code)).toEqual(["MEAL_SHORT"]);
    expect(row.flags[0].message).toContain("40 min");
  });

  it("counts drivers and alerts across the company, never another company's", async () => {
    const response = await get(reportPath(CARRIER, `from=${yesterday}&to=${today}`), tokens.admin);
    const body = response.json();

    const driverIds = body.data.map((row: { driverId: string }) => row.driverId);

    expect(driverIds).toContain(reportDriver);
    expect(driverIds).not.toContain(ids.otherDriver);
    expect(body.searchMeta.facets.driverId.map((facet: { value: string }) => facet.value)).not.toContain(
      ids.otherDriver,
    );
    expect(
      body.searchMeta.facets.flag.find((facet: { value: string }) => facet.value === "MEAL_SHORT")
        .count,
    ).toBeGreaterThanOrEqual(1);

    const onlyAlerts = await get(
      reportPath(CARRIER, `from=${yesterday}&to=${today}&flag=MEAL_SHORT`),
      tokens.admin,
    );

    expect(onlyAlerts.json().data.map((row: { driverId: string }) => row.driverId)).toEqual([
      reportDriver,
    ]);
  });

  it("refuses an inverted or too long range, and an unknown alert", async () => {
    expect(refusal(await get(reportPath(CARRIER, `from=${today}&to=${yesterday}`), tokens.admin))).toBe(
      "400 PAUSE_REPORT_RANGE_INVALID",
    );
    expect(
      refusal(await get(reportPath(CARRIER, `from=2026-01-01&to=2026-03-01`), tokens.admin)),
    ).toBe("400 PAUSE_REPORT_RANGE_INVALID");
    expect(refusal(await get(reportPath(CARRIER, "flag=TIRED"), tokens.admin))).toBe(
      "400 VALIDATION_ERROR",
    );

    // Shifting year 9999 threw a bare RangeError: a 500.
    expect(refusal(await get(reportPath(CARRIER, "to=9999-12-31"), tokens.admin))).toBe(
      "400 PAUSE_REPORT_RANGE_INVALID",
    );
    expect(
      refusal(await get(reportPath(CARRIER, "from=0001-01-01&to=0001-01-02"), tokens.admin)),
    ).toBe("400 PAUSE_REPORT_RANGE_INVALID");
  });

  it("serves a pause closed only after 12 hours as forgotten, with its alert", async () => {
    const driver = await newDriver(CARRIER, "Bia Esquecida");
    const dayBefore = shiftDateKey(yesterday, -1);
    const [year, month, day] = dayBefore.split("-").map(Number);
    const at = (hour: number, minute = 0) =>
      zonedWallTimeToUtc(ZONE, year, month, day, hour, minute);

    await prisma.route.create({
      data: {
        code: 901,
        status: "COMPLETED",
        scheduled_date: new Date(`${dayBefore}T00:00:00.000Z`),
        started_at: at(7),
        completed_at: at(17),
        businessId: CARRIER,
        driverId: driver.id,
      },
    });

    await prisma.driverPause.create({
      data: {
        kind: "MEAL",
        started_at: at(12),
        ended_at: at(31, 50), // 07:50 of the next day
        start_submission_id: randomUUID(),
        end_submission_id: randomUUID(),
        businessId: CARRIER,
        driverId: driver.id,
        occurrenceTypeId: await pauseTypeId(prisma, CARRIER, "MEAL"),
      },
    });

    const response = await get(
      reportPath(CARRIER, `from=${dayBefore}&to=${dayBefore}&driverId=${driver.id}`),
      tokens.reader,
    );

    expect(response.statusCode).toBe(200);

    const [row] = response.json().data;

    expect(row.workday.minutes).toBe(600);
    expect(row.totals.mealMinutes).toBe(0);
    expect(row.pauses[0]).toMatchObject({ status: "TOO_LONG", duration_minutes: 1190 });
    expect(row.flags.map((flag: { code: string }) => flag.code)).toContain("PAUSE_TOO_LONG");
  });
});
