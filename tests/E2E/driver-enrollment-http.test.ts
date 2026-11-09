import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createHash, randomUUID } from "node:crypto";

import { decode } from "jsonwebtoken";

import { createPrismaClient } from "@/shared/database/database-client";
import { ENROLLMENT_MAX_ATTEMPTS } from "@/modules/user/services/driver-enrollment";
import { hashDeviceId } from "@/modules/user/services/session-service";

import {
  freshAddress,
  openSession,
  seedCarrier,
  seedDriver,
  seedLogin,
  type SeededSession,
} from "./support/driver-access-seed";

/**
 * The driver's access QR code (plan of 02/11/2026, D3), the phone-bound
 * session it opens (D4) and the manager's list of phones (D7), through the
 * whole stack against Postgres.
 *
 * The manager shows a QR code (or reads out an 8-character code); the
 * driver's phone reads it once, within ten minutes, and is signed in for up
 * to 30 idle days — on that phone only. What this guards that the unit tests
 * cannot: the hashes at rest, the atomic consumption under a race, the tenant
 * of every manager route, and the session tables after a revocation.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const PHONE = "23be03c084165505";
const OTHER_PHONE = "9f1c03c084160000";

let CARRIER = "";
let OTHER_CARRIER = "";
let manager: SeededSession;
let otherManager: SeededSession;
let OFFICE_USER = "";

const carriers: string[] = [];

const address = () => freshAddress("10.83");
const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

let cpfSeed = 100_000_000;

/** A CPF with valid check digits, never anybody's: 9 digits from a counter. */
function nextCpf(): string {
  const base = String((cpfSeed += 7)).padStart(9, "0");
  const digit = (digits: string, length: number) => {
    let sum = 0;
    for (let index = 0; index < length; index += 1) {
      sum += Number(digits[index]) * (length + 1 - index);
    }
    const rest = (sum * 10) % 11;
    return rest === 10 ? 0 : rest;
  };
  const first = digit(base, 9);

  return `${base}${first}${digit(`${base}${first}`, 10)}`;
}

async function driverLogin(
  businessId = CARRIER,
  status: "ACTIVE" | "INACTIVE" = "ACTIVE",
): Promise<{ userId: string; driverId: string }> {
  const driverId = await seedDriver(prisma, businessId, {
    cpf: nextCpf(),
    status,
  });
  const userId = await seedLogin(prisma, {
    businessId,
    role: "BUSINESS_USER",
    driverId,
  });

  return { userId, driverId };
}

const issue = (userId: string, session: SeededSession = manager) =>
  app.inject({
    method: "POST",
    url: `/user/${userId}/enrollment`,
    remoteAddress: address(),
    headers: { authorization: `Bearer ${session.access}` },
  });

const enroll = (payload: Record<string, unknown>, remoteAddress = address()) =>
  app.inject({
    method: "POST",
    url: "/user/session/enroll",
    remoteAddress,
    payload,
  });

const refresh = (token: string, deviceId?: string) =>
  app.inject({
    method: "POST",
    url: "/user/refresh-token",
    remoteAddress: address(),
    payload: { token, ...(deviceId === undefined ? {} : { deviceId }) },
  });

async function issued(userId: string) {
  const response = await issue(userId);

  expect(response.statusCode).toBe(201);

  return response.json() as {
    qrToken: string;
    qrContent: string;
    accessCode: string;
    expiresAt: string;
    expiresIn: number;
  };
}

beforeAll(async () => {
  CARRIER = await seedCarrier(prisma);
  OTHER_CARRIER = await seedCarrier(prisma);
  carriers.push(CARRIER, OTHER_CARRIER);

  otherManager = await openSession(
    prisma,
    await seedLogin(prisma, {
      businessId: OTHER_CARRIER,
      role: "BUSINESS_ADMIN",
    }),
  );

  OFFICE_USER = await seedLogin(prisma, {
    businessId: CARRIER,
    role: "BUSINESS_ADMIN",
  });

  ({ app } = await import("@/http"));
  await app.ready();
}, 90_000);

// A manager of their own per test: issuing is limited to ten a minute per
// user, and those counters live in Redis across runs.
beforeEach(async () => {
  manager = await openSession(
    prisma,
    await seedLogin(prisma, { businessId: CARRIER, role: "BUSINESS_ADMIN" }),
  );
});

afterAll(async () => {
  await prisma.business.deleteMany({ where: { id: { in: carriers } } });

  await app?.close();
  await prisma.$disconnect();
});

describe("issuing the access QR code", () => {
  it("returns the token, the QR content and the short code once, and keeps only their hashes", async () => {
    const { userId } = await driverLogin();
    const before = Date.now();

    const body = await issued(userId);

    expect(body.qrToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.qrContent).toBe(
      `trajetto-enroll:1:development:${body.qrToken}`,
    );
    expect(body.accessCode).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(body.expiresIn).toBe(600);
    expect(Date.parse(body.expiresAt) - before).toBeGreaterThan(590_000);

    const row = await prisma.driverEnrollmentToken.findUniqueOrThrow({
      where: { userId },
    });

    expect(row.token_hash).toBe(sha256(body.qrToken));
    expect(row.code_hash).toBe(sha256(body.accessCode.replace("-", "")));
    expect(JSON.stringify(row)).not.toContain(body.qrToken);
    expect(JSON.stringify(row)).not.toContain(body.accessCode.replace("-", ""));
  });

  it("replaces the previous code: a screenshot of the old one stops working", async () => {
    const { userId } = await driverLogin();
    const first = await issued(userId);
    const second = await issued(userId);

    const old = await enroll({ qrToken: first.qrToken, deviceId: PHONE });

    expect(old.statusCode).toBe(401);
    expect(old.json().code).toBe("AUTH_ENROLLMENT_INVALID");

    expect(
      (await enroll({ qrToken: second.qrToken, deviceId: PHONE })).statusCode,
    ).toBe(200);
  });

  it("answers another company's driver like a missing one (404)", async () => {
    const { userId } = await driverLogin();

    const response = await issue(userId, otherManager);

    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe("USER_NOT_FOUND");
    expect(
      await prisma.driverEnrollmentToken.count({ where: { userId } }),
    ).toBe(0);

    const unknown = await issue(randomUUID());
    expect(unknown.statusCode).toBe(404);
  });

  it("refuses an office user, an inactive driver and a revoked access (409)", async () => {
    const office = await issue(OFFICE_USER);

    expect(office.statusCode).toBe(409);
    expect(office.json().code).toBe("USER_NOT_DRIVER");

    const inactive = await driverLogin(CARRIER, "INACTIVE");
    const inactiveResponse = await issue(inactive.userId);

    expect(inactiveResponse.statusCode).toBe(409);
    expect(inactiveResponse.json().code).toBe("DRIVER_INACTIVE");

    const revoked = await driverLogin();
    await prisma.user.update({
      where: { id: revoked.userId },
      data: { access_revoked: true },
    });
    const revokedResponse = await issue(revoked.userId);

    expect(revokedResponse.statusCode).toBe(409);
    expect(revokedResponse.json().code).toBe("USER_ACCESS_REVOKED");
  });

  it("refuses a driver's own token: only a manager issues codes", async () => {
    const { userId } = await driverLogin();
    const driverSession = await openSession(prisma, userId);

    const response = await issue(userId, driverSession);

    expect(response.statusCode).toBe(403);
  });
});

describe("signing in with it", () => {
  it("opens a session bound to the phone, once", async () => {
    const { userId } = await driverLogin();
    const { qrToken } = await issued(userId);

    const response = await enroll({ qrToken, deviceId: PHONE });

    expect(response.statusCode).toBe(200);

    const { token, refresh_token, role } = response.json();

    expect(role).toBe("BUSINESS_USER");
    expect(decode(token)).toMatchObject({ sub: userId });
    expect(decode(refresh_token)).toMatchObject({
      sessionClient: "driver_device",
    });

    const rows = await prisma.refreshToken.findMany({ where: { userId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].device_id).toBe(PHONE);

    const enrollment = await prisma.driverEnrollmentToken.findUniqueOrThrow({
      where: { userId },
    });
    expect(enrollment.consumed_at).not.toBeNull();
    expect(enrollment.device_id).toBe(PHONE);

    const me = await app.inject({
      method: "GET",
      url: "/user/me",
      remoteAddress: address(),
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.statusCode).toBe(200);

    const again = await enroll({ qrToken, deviceId: OTHER_PHONE });
    expect(again.statusCode).toBe(401);
    expect(again.json().code).toBe("AUTH_ENROLLMENT_INVALID");
  });

  it("takes the short code typed in any case, with or without the hyphen", async () => {
    const { userId } = await driverLogin();
    const { accessCode } = await issued(userId);

    const response = await enroll({
      accessCode: ` ${accessCode.toLowerCase()} `,
      deviceId: PHONE,
    });

    expect(response.statusCode).toBe(200);
  });

  it("gives one session when two phones read the same QR code at once", async () => {
    const { userId } = await driverLogin();
    const { qrToken } = await issued(userId);

    const responses = await Promise.all([
      enroll({ qrToken, deviceId: PHONE }),
      enroll({ qrToken, deviceId: OTHER_PHONE }),
      enroll({ qrToken, deviceId: PHONE }),
    ]);

    expect(responses.map((response) => response.statusCode).sort()).toEqual([
      200, 401, 401,
    ]);
    expect(await prisma.refreshToken.count({ where: { userId } })).toBe(1);
  });

  it("refuses an expired code with the same answer as an unknown one", async () => {
    const { userId } = await driverLogin();
    const { qrToken } = await issued(userId);

    await prisma.driverEnrollmentToken.update({
      where: { userId },
      data: { expires_at: new Date(Date.now() - 1_000) },
    });

    const expired = await enroll({ qrToken, deviceId: PHONE });
    const unknown = await enroll({ qrToken: "nao-existe", deviceId: PHONE });

    expect(expired.statusCode).toBe(401);
    expect(expired.json()).toEqual(unknown.json());
  });

  it("tells an inactive driver why, counts it, and spends the code after the cap", async () => {
    const { userId, driverId } = await driverLogin();
    const { qrToken } = await issued(userId);

    // Inactivated behind the route's back (the route also deletes the code).
    await prisma.driver.update({
      where: { id: driverId },
      data: { status: "INACTIVE" },
    });

    for (let attempt = 0; attempt < ENROLLMENT_MAX_ATTEMPTS; attempt += 1) {
      const refused = await enroll({ qrToken, deviceId: PHONE });

      expect(refused.statusCode).toBe(403);
      expect(refused.json().code).toBe("AUTH_DRIVER_INACTIVE");
    }

    await prisma.driver.update({
      where: { id: driverId },
      data: { status: "ACTIVE" },
    });

    const spent = await enroll({ qrToken, deviceId: PHONE });

    expect(spent.statusCode).toBe(401);
    expect(await prisma.refreshToken.count({ where: { userId } })).toBe(0);
  });

  it("refuses a body without the phone, or with both codes", async () => {
    const { userId } = await driverLogin();
    const { qrToken, accessCode } = await issued(userId);

    expect((await enroll({ qrToken })).statusCode).toBe(400);
    expect(
      (await enroll({ qrToken, accessCode, deviceId: PHONE })).statusCode,
    ).toBe(400);
    expect(
      (await enroll({ qrToken, deviceId: "nao-e-um-aparelho" })).statusCode,
    ).toBe(400);
  });

  it("is held to eight attempts a minute per address", async () => {
    // Its own address per run: the counters live in Redis across runs.
    const from = `10.84.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`;
    const statuses: number[] = [];

    for (let attempt = 0; attempt < 9; attempt += 1) {
      statuses.push(
        (await enroll({ accessCode: "ABCD-EFGH", deviceId: PHONE }, from))
          .statusCode,
      );
    }

    expect(statuses.slice(0, 8).every((status) => status === 401)).toBe(true);
    expect(statuses[8]).toBe(429);
  });
});

describe("the session it opened (D4)", () => {
  async function phoneSession(deviceId = PHONE) {
    const { userId } = await driverLogin();
    const { qrToken } = await issued(userId);
    const response = await enroll({ qrToken, deviceId });

    expect(response.statusCode).toBe(200);

    return { userId, ...(response.json() as { refresh_token: string }) };
  }

  it("renews from the same phone", async () => {
    const { userId, refresh_token } = await phoneSession();

    const response = await refresh(refresh_token, PHONE);

    expect(response.statusCode).toBe(200);

    const rows = await prisma.refreshToken.findMany({ where: { userId } });
    expect(rows.map((row) => row.device_id)).toEqual([PHONE, PHONE]);
  });

  it("refuses a renewal from another phone, or from no phone, and spends nothing", async () => {
    const { userId, refresh_token } = await phoneSession();

    for (const deviceId of [OTHER_PHONE, undefined]) {
      const refused = await refresh(refresh_token, deviceId);

      expect(refused.statusCode).toBe(401);
      expect(refused.json().code).toBe("AUTH_DEVICE_MISMATCH");
    }

    const [row] = await prisma.refreshToken.findMany({ where: { userId } });
    expect(row.revoked_at).toBeNull();

    expect((await refresh(refresh_token, PHONE)).statusCode).toBe(200);
  });
});

describe("the driver's phones, as the manager sees them (D7)", () => {
  async function signedInOn(userId: string, deviceId: string) {
    const { qrToken } = await issued(userId);
    const response = await enroll({ qrToken, deviceId });

    expect(response.statusCode).toBe(200);

    return response.json() as { token: string; refresh_token: string };
  }

  const devices = (userId: string, session: SeededSession = manager) =>
    app.inject({
      method: "GET",
      url: `/user/${userId}/devices`,
      remoteAddress: address(),
      headers: { authorization: `Bearer ${session.access}` },
    });

  const revokeDevice = (
    userId: string,
    deviceId: string,
    session: SeededSession = manager,
  ) =>
    app.inject({
      method: "DELETE",
      url: `/user/${userId}/devices/${deviceId}`,
      remoteAddress: address(),
      headers: { authorization: `Bearer ${session.access}` },
    });

  // Wave 2: the phone's id is what the CPF login checks the phone by, and
  // this list is open to a profile that may only read users. Each phone is
  // its hash; `deviceId` repeats it under the field's previous name.
  it("lists each phone by its hash, never its id, with its last activity, and not the e-mail sessions", async () => {
    const { userId } = await driverLogin();

    await signedInOn(userId, PHONE);
    await signedInOn(userId, OTHER_PHONE);
    await openSession(prisma, userId);

    const response = await devices(userId);

    expect(response.statusCode).toBe(200);

    const { data } = response.json() as {
      data: Array<{ deviceHash: string; deviceId: string; sessions: number }>;
    };

    expect(data.map((device) => device.deviceHash).sort()).toEqual(
      [hashDeviceId(OTHER_PHONE), hashDeviceId(PHONE)].sort(),
    );
    expect(data.every((device) => device.deviceId === device.deviceHash)).toBe(
      true,
    );
    expect(response.body).not.toContain(PHONE);
    expect(response.body).not.toContain(OTHER_PHONE);
    expect(data[0]).toMatchObject({
      sessions: 1,
      lastActivityAt: expect.any(String),
      expiresAt: expect.any(String),
    });
  });

  it("ends that phone's sessions and push devices, and leaves the other phone", async () => {
    const { userId } = await driverLogin();
    const lost = await signedInOn(userId, PHONE);
    const kept = await signedInOn(userId, OTHER_PHONE);

    const lostFamily = (decode(lost.refresh_token) as { familyId: string })
      .familyId;
    const push = `ExponentPushToken[${randomUUID()}]`;

    await prisma.pushDeviceToken.create({
      data: {
        userId,
        token: push,
        platform: "android",
        session_family_id: lostFamily,
      },
    });

    const response = await revokeDevice(
      userId,
      hashDeviceId(PHONE).toUpperCase(),
    );

    expect(response.statusCode).toBe(204);
    expect(
      await prisma.refreshToken.count({ where: { family_id: lostFamily } }),
    ).toBe(0);
    expect(await prisma.pushDeviceToken.count({ where: { token: push } })).toBe(
      0,
    );

    expect((await refresh(lost.refresh_token, PHONE)).statusCode).toBe(401);
    expect((await refresh(kept.refresh_token, OTHER_PHONE)).statusCode).toBe(
      200,
    );

    const { data } = (await devices(userId)).json() as {
      data: Array<{ deviceHash: string }>;
    };
    expect(data.map((device) => device.deviceHash)).toEqual([
      hashDeviceId(OTHER_PHONE),
    ]);

    // Again, by the phone's id (a page loaded before the list stopped
    // giving it): nothing left to end, the same answer.
    expect((await revokeDevice(userId, PHONE)).statusCode).toBe(204);
  });

  it("refuses a phone that is neither a hash nor an id (400)", async () => {
    const { userId } = await driverLogin();

    expect((await revokeDevice(userId, "nao-e-aparelho")).statusCode).toBe(400);
  });

  it("answers another company's driver like a missing one (404), and ends nothing", async () => {
    const { userId } = await driverLogin();
    const session = await signedInOn(userId, PHONE);

    const listed = await devices(userId, otherManager);
    const revoked = await revokeDevice(userId, PHONE, otherManager);

    expect(listed.statusCode).toBe(404);
    expect(listed.json().code).toBe("USER_NOT_FOUND");
    expect(revoked.statusCode).toBe(404);
    expect((await refresh(session.refresh_token, PHONE)).statusCode).toBe(200);
  });

  it("refuses an office user's sessions (409)", async () => {
    const response = await devices(OFFICE_USER);

    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("USER_NOT_DRIVER");
  });
});
