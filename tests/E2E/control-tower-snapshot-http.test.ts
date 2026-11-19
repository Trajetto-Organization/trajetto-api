import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { randomUUID } from "node:crypto";

import { sign } from "jsonwebtoken";

import auth from "@/config/auth";
import { env } from "@/env";
import { controlTowerSnapshot } from "@/modules/route/usecases/control-tower/control-tower-usecase";
import { operationSummarySnapshot } from "@/modules/delivery/usecases/operation-summary/operation-summary-usecase";
import { encodeLiveRoutesCursor } from "@/modules/route/usecases/live-routes/live-routes";
import { liveRoutesSnapshot } from "@/modules/route/usecases/live-routes/live-routes-usecase";
import { tenantSnapshotMemory } from "@/shared/cache/tenant-snapshot";
import { businessDateKey, businessDayRange } from "@/shared/time/business-day";

import { createPrismaClient } from "@/shared/database/database-client";

/**
 * The control tower, the operation summary and the first page of
 * /route/live through the company's snapshot (plano-escala F4-11, decision
 * D2), over real HTTP and Postgres:
 *  - a copy is byte for byte the answer the route gives without the
 *    snapshot, with the same content type;
 *  - it is served for up to TOWER_SNAPSHOT_TTL_MS, answers 304 to the ETag
 *    a client holds, and x-trajetto-refresh reads again only a copy at
 *    least 2 s old;
 *  - with the copy hot, every guard still runs on every request (session,
 *    module, permission, driver, tenant, the MASTER's company), and no
 *    company ever gets another one's copy;
 *  - fifty operators at once are one computation; a page after a cursor
 *    and TOWER_SNAPSHOT_TTL_MS=0 are read as before, without ETag.
 *
 * The clock is frozen (only Date: timers, Postgres and Redis run for real)
 * so a body computed through the snapshot can be compared with one read
 * without it at the same instant: the tower's dots, "aguardando" and
 * /route/live's generatedAt depend on the clock.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const id = (suffix: string) =>
  `018feb00-0000-7000-8000-${suffix.padStart(12, "0")}`;

const CARRIER = id("a");
const OTHER = id("b");
const FLEET_ONLY = id("c");

const DRIVER = id("d1");
const OTHER_DRIVER = id("d2");

const ROUTE_RUNNING = id("b1");
const ROUTE_OTHER = id("b9");

const tokens: Record<
  | "admin"
  | "reader"
  | "mechanic"
  | "driver"
  | "otherAdmin"
  | "fleetOnlyAdmin"
  | "master"
  | "revoked"
  | "familyGone",
  string
> = {} as never;

const shippers: Record<string, string> = {};

let cnpjSeq = 0;
let routeCode = 100;

const initialTtl = env.TOWER_SNAPSHOT_TTL_MS;

async function seedBusiness(businessId: string, deliveries = true) {
  cnpjSeq += 1;

  await prisma.business.create({
    data: {
      id: businessId,
      corporate_reason: `Transportadora ${businessId.slice(-2)}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(42444666000100 + cnpjSeq),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `${randomUUID()}@exemplo.com.br`,
    },
  });

  if (!deliveries) return;

  await prisma.businessEntitlement.create({
    data: { businessId, module: "DELIVERIES", enabled: true },
  });

  const shipper = await prisma.shipper.create({
    data: { name: "Embarcador", businessId },
  });

  shippers[businessId] = shipper.id;
}

async function seedDriver(driverId: string, businessId: string, name: string) {
  await prisma.driver.create({
    data: {
      id: driverId,
      name,
      birth_date: new Date("1990-01-01"),
      cnh: `cnh-${driverId.slice(-8)}`,
      cpf: `cpf-${driverId.slice(-8)}`,
      rg: `rg-${driverId.slice(-8)}`,
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
}

async function seedProfile(businessId: string, permissionKey: string) {
  const profile = await prisma.profileAccess.create({
    data: {
      name: `Perfil ${randomUUID().slice(0, 8)}`,
      businessId,
      permissions: {
        create: [
          {
            permissionKey,
            action: permissionKey,
            canRead: true,
            canWrite: false,
            businessId,
          },
        ],
      },
    },
  });

  return profile.id;
}

async function seedUser(data: {
  role: "MASTER" | "BUSINESS_ADMIN" | "BUSINESS_USER";
  businessId?: string;
  driverId?: string;
  profileAccessId?: string;
}): Promise<{ id: string; familyId: string; token: string }> {
  const userId = randomUUID();
  const familyId = randomUUID();

  await prisma.user.create({
    data: {
      id: userId,
      name: "Usuário",
      email: `${userId}@exemplo.com.br`,
      password: "nao-usado",
      role: data.role,
      businessId: data.businessId ?? null,
      driverId: data.driverId ?? null,
      profileAccessId: data.profileAccessId ?? null,
    },
  });

  await prisma.refreshToken.create({
    data: {
      userId,
      token_hash: randomUUID(),
      jti: randomUUID(),
      family_id: familyId,
      expires_in: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

  const token = sign(
    { tokenType: "access", sessionVersion: 0, familyId },
    auth.secret_token,
    { subject: userId, expiresIn: "1h" },
  );

  return { id: userId, familyId, token };
}

const today = () => businessDateKey(new Date(), "America/Sao_Paulo");

/**
 * Halfway between the company's midnight and now: "an hour ago" is
 * yesterday when the suite runs at 00:30 in São Paulo, and the route would
 * read as left open.
 */
function earlierToday(): Date {
  const now = Date.now();
  const midnight = businessDayRange(
    new Date(now),
    "America/Sao_Paulo",
  ).start.getTime();

  return new Date(midnight + Math.floor((now - midnight) / 2));
}

/**
 * A route on the street with one delivery on the way: it changes all three
 * answers at once (the tower's active routes, the summary's "em rota" and
 * its board, a row of /route/live), and each of them names its driver.
 * Returns the driver's id.
 */
async function addRunningRoute(
  businessId: string,
  routeId: string = randomUUID(),
  driverId: string = randomUUID(),
) {
  await seedDriver(driverId, businessId, `Motorista ${routeId.slice(-4)}`);

  routeCode += 1;

  await prisma.route.create({
    data: {
      id: routeId,
      code: routeCode,
      status: "IN_PROGRESS",
      scheduled_date: new Date(`${today()}T00:00:00.000Z`),
      started_at: earlierToday(),
      businessId,
      driverId,
    },
  });

  const delivery = await prisma.delivery.create({
    data: {
      recipient_name: `Cliente ${randomUUID().slice(0, 4)}`,
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      status: "IN_TRANSIT",
      driverId,
      businessId,
      shipperId: shippers[businessId],
    },
  });

  await prisma.routeStop.create({
    data: {
      sequence: 10,
      status: "PENDING",
      routeId,
      deliveryId: delivery.id,
    },
  });

  return driverId;
}

const get = (
  url: string,
  token: string,
  headers: Record<string, string> = {},
) =>
  app.inject({
    method: "GET",
    url,
    headers: { authorization: `Bearer ${token}`, ...headers },
  });

const withBusiness = (url: string, businessId: string) =>
  `${url}?businessId=${businessId}`;

const READS = [
  {
    name: "the control tower",
    url: "/route/control-tower",
    snapshot: controlTowerSnapshot,
  },
  {
    name: "the operation summary",
    url: "/delivery/operation-summary",
    snapshot: operationSummarySnapshot,
  },
  {
    name: "the first page of /route/live",
    url: "/route/live",
    snapshot: liveRoutesSnapshot,
  },
] as const;

beforeAll(async () => {
  await seedBusiness(CARRIER);
  await seedBusiness(OTHER);
  await seedBusiness(FLEET_ONLY, false);

  const reader = await seedProfile(CARRIER, "delivery_manage");
  const mechanic = await seedProfile(CARRIER, "fuel_manage");

  await addRunningRoute(CARRIER, ROUTE_RUNNING, DRIVER);
  await addRunningRoute(OTHER, ROUTE_OTHER, OTHER_DRIVER);

  tokens.admin = (
    await seedUser({ role: "BUSINESS_ADMIN", businessId: CARRIER })
  ).token;
  tokens.reader = (
    await seedUser({
      role: "BUSINESS_USER",
      businessId: CARRIER,
      profileAccessId: reader,
    })
  ).token;
  tokens.mechanic = (
    await seedUser({
      role: "BUSINESS_USER",
      businessId: CARRIER,
      profileAccessId: mechanic,
    })
  ).token;
  tokens.driver = (
    await seedUser({
      role: "BUSINESS_USER",
      businessId: CARRIER,
      driverId: DRIVER,
      profileAccessId: reader,
    })
  ).token;
  tokens.otherAdmin = (
    await seedUser({ role: "BUSINESS_ADMIN", businessId: OTHER })
  ).token;
  tokens.fleetOnlyAdmin = (
    await seedUser({ role: "BUSINESS_ADMIN", businessId: FLEET_ONLY })
  ).token;
  tokens.master = (await seedUser({ role: "MASTER" })).token;

  // Signed out everywhere (session_version moved on), and a session whose
  // refresh family is gone: both were valid users of the company.
  const revoked = await seedUser({
    role: "BUSINESS_ADMIN",
    businessId: CARRIER,
  });

  await prisma.user.update({
    where: { id: revoked.id },
    data: { session_version: 1 },
  });
  tokens.revoked = revoked.token;

  const familyGone = await seedUser({
    role: "BUSINESS_ADMIN",
    businessId: CARRIER,
  });

  await prisma.refreshToken.deleteMany({ where: { userId: familyGone.id } });
  tokens.familyGone = familyGone.token;

  ({ app } = await import("@/http"));
  await app.ready();
}, 180_000);

afterAll(async () => {
  env.TOWER_SNAPSHOT_TTL_MS = initialTtl;

  await app?.close();
  await prisma.$disconnect();
});

let frozenAt = 0;

beforeEach(() => {
  env.TOWER_SNAPSHOT_TTL_MS = 10_000;
  tenantSnapshotMemory().clear();

  frozenAt = Date.now();
  vi.useFakeTimers({ toFake: ["Date"], now: frozenAt });
});

afterEach(() => {
  vi.useRealTimers();
  env.TOWER_SNAPSHOT_TTL_MS = 10_000;
});

/** Moves the frozen clock to `ms` after the test froze it. */
const clockAt = (ms: number) => vi.setSystemTime(frozenAt + ms);

describe("a copy is the answer, byte for byte", () => {
  it.each(READS)("$name", async ({ url }) => {
    env.TOWER_SNAPSHOT_TTL_MS = 0;

    const before = await get(url, tokens.admin);

    env.TOWER_SNAPSHOT_TTL_MS = 10_000;

    const computed = await get(url, tokens.admin);
    const copy = await get(url, tokens.reader);

    expect(before.statusCode, before.body).toBe(200);
    expect(before.headers.etag).toBeUndefined();
    expect(before.headers.age).toBeUndefined();
    expect(before.headers["cache-control"]).toBeUndefined();

    expect(computed.statusCode, computed.body).toBe(200);
    expect(computed.body).toBe(before.body);
    expect(computed.headers["content-type"]).toBe(
      before.headers["content-type"],
    );
    expect(computed.headers.etag).toMatch(/^"[A-Za-z0-9_-]{27}"$/);
    expect(computed.headers.age).toBe("0");
    expect(computed.headers["cache-control"]).toBe("private, no-cache");

    expect(copy.statusCode).toBe(200);
    expect(copy.body).toBe(before.body);
    expect(copy.headers.etag).toBe(computed.headers.etag);

    const notModified = await get(url, tokens.reader, {
      "if-none-match": String(computed.headers.etag),
    });

    expect(notModified.statusCode).toBe(304);
    expect(notModified.body).toBe("");
    expect(notModified.headers.etag).toBe(computed.headers.etag);
    expect(notModified.headers["cache-control"]).toBe("private, no-cache");
  });
});

describe("a copy lasts the TTL, and the refresh hint reads again only after 2 s", () => {
  it.each(READS)("$name", async ({ url }) => {
    const first = await get(url, tokens.admin);

    expect(first.statusCode, first.body).toBe(200);

    const added = await addRunningRoute(CARRIER);

    // The new route and its driver are in the database, not in the copy.
    const cached = await get(url, tokens.admin);
    const tooSoon = await get(url, tokens.admin, { "x-trajetto-refresh": "1" });

    clockAt(1_999);

    const stillTooSoon = await get(url, tokens.admin, {
      "x-trajetto-refresh": "1",
    });

    for (const answer of [cached, tooSoon, stillTooSoon]) {
      expect(answer.body).toBe(first.body);
      expect(answer.headers.etag).toBe(first.headers.etag);
    }

    expect(stillTooSoon.headers.age).toBe("1");
    expect(first.body).not.toContain(added);

    clockAt(2_000);

    const refreshed = await get(url, tokens.admin, {
      "x-trajetto-refresh": "1",
    });

    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.body).toContain(added);
    expect(refreshed.headers.etag).not.toBe(first.headers.etag);
    expect(refreshed.headers.age).toBe("0");

    // The ETag a client still holds is the old one: it gets the new body.
    const changed = await get(url, tokens.reader, {
      "if-none-match": String(first.headers.etag),
    });

    expect(changed.statusCode).toBe(200);
    expect(changed.body).toBe(refreshed.body);

    // Still the answer the route gives without the snapshot, at this instant.
    env.TOWER_SNAPSHOT_TTL_MS = 0;
    expect((await get(url, tokens.admin)).body).toBe(refreshed.body);
    env.TOWER_SNAPSHOT_TTL_MS = 10_000;

    const another = await addRunningRoute(CARRIER);

    clockAt(2_000 + 9_999);

    const old = await get(url, tokens.admin);

    expect(old.body).toBe(refreshed.body);
    expect(old.headers.age).toBe("9");

    clockAt(2_000 + 10_000);

    const expired = await get(url, tokens.admin);

    expect(expired.body).toContain(another);
    expect(expired.headers.age).toBe("0");
  });
});

describe("with the copy hot, every request is still checked", () => {
  it.each(READS)("$name", async ({ url }) => {
    const hot = await get(url, tokens.admin);

    expect(hot.statusCode, hot.body).toBe(200);
    expect(hot.body).toContain(DRIVER);

    const refusals: Array<
      [string, Awaited<ReturnType<typeof get>>, number, string?]
    > = [
      ["no session", await app.inject({ method: "GET", url }), 401],
      ["signed out everywhere", await get(url, tokens.revoked), 401],
      ["refresh family gone", await get(url, tokens.familyGone), 401],
      [
        "a profile without the read key",
        await get(url, tokens.mechanic),
        403,
        "PERMISSION_DENIED",
      ],
      ["a driver token", await get(url, tokens.driver), 403],
      [
        "a company without Entregas",
        await get(url, tokens.fleetOnlyAdmin),
        403,
        "MODULE_NOT_ENABLED",
      ],
      [
        "another company naming this one",
        await get(withBusiness(url, CARRIER), tokens.otherAdmin),
        403,
        "TENANT_ACCESS_DENIED",
      ],
      [
        "a MASTER naming no company",
        await get(url, tokens.master),
        400,
        "BUSINESS_NOT_IDENTIFIED",
      ],
    ];

    for (const [who, answer, status, code] of refusals) {
      expect(answer.statusCode, `${who}: ${answer.body}`).toBe(status);
      expect(answer.body, who).not.toContain(DRIVER);
      expect(answer.headers.etag, who).toBeUndefined();

      if (code) expect(answer.json(), who).toMatchObject({ code });
    }

    // The same request with the copy's ETag is refused the same way.
    const forged = await get(url, tokens.mechanic, {
      "if-none-match": String(hot.headers.etag),
    });

    expect(forged.statusCode).toBe(403);
  });

  it.each(READS)("$name never reaches another company", async ({ url }) => {
    const hot = await get(url, tokens.admin);
    const other = await get(url, tokens.otherAdmin, {
      "if-none-match": String(hot.headers.etag),
    });

    expect(other.statusCode, other.body).toBe(200);
    expect(other.body).toContain(OTHER_DRIVER);
    expect(other.body).not.toContain(DRIVER);
    expect(other.headers.etag).not.toBe(hot.headers.etag);

    const masterHere = await get(withBusiness(url, CARRIER), tokens.master);
    const masterThere = await get(withBusiness(url, OTHER), tokens.master);

    expect(masterHere.body).toBe(hot.body);
    expect(masterHere.headers.etag).toBe(hot.headers.etag);
    expect(masterThere.body).toBe(other.body);
  });
});

describe("one computation for a crowd", () => {
  it.each(READS)(
    "$name: fifty operators at once",
    async ({ url, snapshot }) => {
      const computes = snapshot.stats().computes;

      const answers = await Promise.all(
        Array.from({ length: 50 }, (_, index) =>
          get(url, index % 2 === 0 ? tokens.admin : tokens.reader),
        ),
      );

      expect(answers.map((answer) => answer.statusCode)).toEqual(
        Array.from({ length: 50 }, () => 200),
      );
      expect(new Set(answers.map((answer) => answer.body)).size).toBe(1);
      expect(snapshot.stats().computes - computes).toBe(1);
    },
  );
});

describe("what stays as before", () => {
  it("reads a page after a cursor on the spot, without ETag", async () => {
    await get("/route/live", tokens.admin);

    const page = await get(
      `/route/live?cursor=${encodeLiveRoutesCursor({ rank: 0, code: 0 })}`,
      tokens.admin,
    );

    expect(page.statusCode, page.body).toBe(200);
    expect(page.headers.etag).toBeUndefined();
    expect(page.body).toContain(DRIVER);
  });

  it.each(READS)(
    "$name with TOWER_SNAPSHOT_TTL_MS=0: no copy, no ETag, no 304",
    async ({ url }) => {
      env.TOWER_SNAPSHOT_TTL_MS = 0;

      const first = await get(url, tokens.admin);
      const added = await addRunningRoute(CARRIER);
      const second = await get(url, tokens.admin, { "if-none-match": "*" });

      expect(first.headers.etag).toBeUndefined();
      expect(second.statusCode).toBe(200);
      expect(second.headers.etag).toBeUndefined();
      expect(second.body).toContain(added);
    },
  );
});
