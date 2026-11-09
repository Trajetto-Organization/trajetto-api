import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import { decode } from "jsonwebtoken";

import { createPrismaClient } from "@/shared/database/database-client";

import {
  freshAddress,
  openSession,
  seedCarrier,
  seedDriver,
  seedLogin,
  seedTrustedDevice,
  type SeededSession,
} from "./support/driver-access-seed";

/**
 * Inactivating a driver (plan of 02/11/2026, D5) and what the app sees on
 * its next launch (D6), through the whole stack.
 *
 * The inactivation only pushed a security event to an open socket: the
 * sessions, the phone's push devices and an access QR code still on a screen
 * all stayed on the server. They go now, in the request that inactivates.
 * And the app, which checks GET /user/me on every launch, must hear WHY it
 * is being signed out: 403 AUTH_DRIVER_INACTIVE, not a bare "session ended".
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const PHONE = "23be03c084165505";
const PASSWORD = "senha-do-motorista";

let CARRIER = "";
let manager: SeededSession;

const address = () => freshAddress("10.87");

let cpfSeed = 300_000_000;

function nextCpf(): string {
  const base = String((cpfSeed += 13)).padStart(9, "0");
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

const inactivate = (driverId: string) =>
  app.inject({
    method: "PATCH",
    url: `/driver/update-driver/${driverId}/business/${CARRIER}`,
    remoteAddress: address(),
    headers: { authorization: `Bearer ${manager.access}` },
    // The edit form always sends the birth date (the schema requires it).
    payload: { birth_date: "1990-01-01T03:00:00.000Z", status: "INACTIVE" },
  });

beforeAll(async () => {
  CARRIER = await seedCarrier(prisma);
  manager = await openSession(
    prisma,
    await seedLogin(prisma, { businessId: CARRIER, role: "BUSINESS_ADMIN" }),
  );

  ({ app } = await import("@/http"));
  await app.ready();
}, 90_000);

afterAll(async () => {
  await prisma.business.deleteMany({ where: { id: CARRIER } });

  await app?.close();
  await prisma.$disconnect();
});

describe("inactivating a driver who is signed in on a phone", () => {
  it("ends the sessions, unregisters the phone and spends the QR code; the next launch hears 403", async () => {
    const cpf = nextCpf();
    const driverId = await seedDriver(prisma, CARRIER, { cpf });
    const userId = await seedLogin(prisma, {
      businessId: CARRIER,
      role: "BUSINESS_USER",
      driverId,
      password: PASSWORD,
    });

    // The driver signs in on the phone a QR code trusted (wave 2), by CPF,
    // and the phone registers for push under that session.
    await seedTrustedDevice(prisma, userId, PHONE);

    const signedIn = await app.inject({
      method: "POST",
      url: "/user/session",
      remoteAddress: address(),
      payload: { cpf, password: PASSWORD, deviceId: PHONE },
    });

    expect(signedIn.statusCode).toBe(200);

    const { token, refresh_token } = signedIn.json();
    const familyId = (decode(refresh_token) as { familyId: string }).familyId;
    const push = `ExponentPushToken[${randomUUID()}]`;

    await prisma.pushDeviceToken.create({
      data: {
        userId,
        token: push,
        platform: "android",
        session_family_id: familyId,
      },
    });

    // And the manager left a QR code on the screen.
    const qr = await app.inject({
      method: "POST",
      url: `/user/${userId}/enrollment`,
      remoteAddress: address(),
      headers: { authorization: `Bearer ${manager.access}` },
    });

    expect(qr.statusCode).toBe(201);

    const versionBefore = (
      await prisma.user.findUniqueOrThrow({ where: { id: userId } })
    ).session_version;

    expect((await inactivate(driverId)).statusCode).toBe(200);

    expect(await prisma.refreshToken.count({ where: { userId } })).toBe(0);
    expect(await prisma.pushDeviceToken.count({ where: { token: push } })).toBe(
      0,
    );
    expect(
      await prisma.driverEnrollmentToken.count({ where: { userId } }),
    ).toBe(0);
    // Wave 2: the phones it trusted for CPF and password go too.
    expect(await prisma.driverTrustedDevice.count({ where: { userId } })).toBe(
      0,
    );

    // D6: the app's launch check says why, so the app signs out with the
    // right message — not a bare "session ended".
    const launch = await app.inject({
      method: "GET",
      url: "/user/me",
      remoteAddress: address(),
      headers: { authorization: `Bearer ${token}` },
    });

    expect(launch.statusCode).toBe(403);
    expect(launch.json().code).toBe("AUTH_DRIVER_INACTIVE");
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: userId } }))
        .session_version,
    ).toBe(versionBefore);

    // Nothing renews, and the QR code opens nothing.
    const renewed = await app.inject({
      method: "POST",
      url: "/user/refresh-token",
      remoteAddress: address(),
      payload: { token: refresh_token, deviceId: PHONE },
    });

    expect([401, 403]).toContain(renewed.statusCode);

    const enrolled = await app.inject({
      method: "POST",
      url: "/user/session/enroll",
      remoteAddress: address(),
      payload: { qrToken: qr.json().qrToken, deviceId: PHONE },
    });

    expect(enrolled.statusCode).toBe(401);
    expect(enrolled.json().code).toBe("AUTH_ENROLLMENT_INVALID");
  });

  it("keeps a reactivated driver signed out until a new QR code", async () => {
    const cpf = nextCpf();
    const driverId = await seedDriver(prisma, CARRIER, { cpf });
    const userId = await seedLogin(prisma, {
      businessId: CARRIER,
      role: "BUSINESS_USER",
      driverId,
      password: PASSWORD,
    });
    await seedTrustedDevice(prisma, userId, PHONE);
    const session = await openSession(prisma, userId);

    expect((await inactivate(driverId)).statusCode).toBe(200);

    const reactivated = await app.inject({
      method: "PATCH",
      url: `/driver/update-driver/${driverId}/business/${CARRIER}`,
      remoteAddress: address(),
      headers: { authorization: `Bearer ${manager.access}` },
      payload: { birth_date: "1990-01-01T03:00:00.000Z", status: "ACTIVE" },
    });

    expect(reactivated.statusCode).toBe(200);

    const launch = await app.inject({
      method: "GET",
      url: "/user/me",
      remoteAddress: address(),
      headers: { authorization: `Bearer ${session.access}` },
    });

    expect(launch.statusCode).toBe(401);
    expect(launch.json().code).toBe("AUTH_SESSION_INVALIDATED");

    // The phone lost its trust with the inactivation (wave 2): CPF and
    // password are refused there until the manager shows a new QR code.
    const byCpf = () =>
      app.inject({
        method: "POST",
        url: "/user/session",
        remoteAddress: address(),
        payload: { cpf, password: PASSWORD, deviceId: PHONE },
      });

    const refused = await byCpf();

    expect(refused.statusCode).toBe(403);
    expect(refused.json().code).toBe("AUTH_DEVICE_NOT_TRUSTED");

    const qr = await app.inject({
      method: "POST",
      url: `/user/${userId}/enrollment`,
      remoteAddress: address(),
      headers: { authorization: `Bearer ${manager.access}` },
    });

    expect(qr.statusCode).toBe(201);

    const enrolled = await app.inject({
      method: "POST",
      url: "/user/session/enroll",
      remoteAddress: address(),
      payload: { qrToken: qr.json().qrToken, deviceId: PHONE },
    });

    expect(enrolled.statusCode).toBe(200);
    expect((await byCpf()).statusCode).toBe(200);
  });
});
