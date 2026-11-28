import "reflect-metadata";

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "Revogar este aparelho" takes the phone's trust (wave 2, 06/11/2026): to
 * sign in by CPF on it again, the driver reads a new QR code. Even a phone
 * whose sessions already lapsed loses it — trusted until somebody says no —
 * and the consumed QR code forgets it, so nothing that reads that row (the
 * password created after the QR) vouches for the phone again.
 */
const realtime = vi.hoisted(() => ({
  sessionEvents: [] as Array<{ sessionId: string; reason: string }>,
}));

vi.mock("@/websocket", () => ({
  sendSecurityEventToSession: (
    sessionId: string,
    payload: { reason: string },
  ) => {
    realtime.sessionEvents.push({ sessionId, reason: payload.reason });
  },
}));

import type { User } from "@/modules/user/dtos/user-dto";
import type { NotificationService } from "@/shared/services/notification-service";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryUserTokensRepository } from "@/modules/user/repositories/in-memory/in-memory-user-tokens-repository";
import { InMemoryDriverTrustedDeviceRepository } from "@/modules/user/repositories/in-memory/in-memory-driver-trusted-device-repository";
import { InMemoryDriverEnrollmentRepository } from "@/modules/user/repositories/in-memory/in-memory-driver-enrollment-repository";

import {
  ListDriverDevicesUseCase,
  RevokeDriverDeviceUseCase,
} from "@/modules/user/usecases/driver-devices/driver-devices-usecases";
import { hashDeviceId } from "@/modules/user/services/session-service";
import { driverDeviceParamsSchema } from "@/schemas/driver-access-schema";

const CARRIER = "018f3800-0000-7000-8000-00000000000a";
const OTHER_CARRIER = "018f3800-0000-7000-8000-00000000000b";
const ADMIN = "018f3800-0000-7000-8000-0000000000a1";
const OTHER_ADMIN = "018f3800-0000-7000-8000-0000000000b1";
const DRIVER_LOGIN = "018f3800-0000-7000-8000-0000000000d1";
const PHONE = "23be03c084165505";
const OTHER_PHONE = "9f1c03c084160000";

let users: InMemoryUserRepository;
let tokens: InMemoryUserTokensRepository;
let trusted: InMemoryDriverTrustedDeviceRepository;
let enrollment: InMemoryDriverEnrollmentRepository;
const activities = vi.fn();

const revoke = () =>
  new RevokeDriverDeviceUseCase(
    users,
    tokens,
    { createActivityIfEnabled: activities } as unknown as NotificationService,
    trusted,
    enrollment,
  );

/** The manager's QR code, spent by `deviceId`. */
async function qrSpentOn(deviceId: string) {
  const row = await enrollment.issue({
    userId: DRIVER_LOGIN,
    businessId: CARRIER,
    token: `qr-${deviceId}`,
    code: null,
    expiresAt: new Date(Date.now() + 10 * 60_000),
    createdById: ADMIN,
  });

  await enrollment.consume(row.id, {
    tokenHash: row.token_hash,
    deviceId,
    maxAttempts: 5,
  });
}

beforeEach(async () => {
  realtime.sessionEvents.length = 0;
  activities.mockClear();

  tokens = new InMemoryUserTokensRepository();
  users = new InMemoryUserRepository({ tokens });
  trusted = new InMemoryDriverTrustedDeviceRepository();
  enrollment = new InMemoryDriverEnrollmentRepository();

  users.user.push(
    {
      id: ADMIN,
      name: "Gestora",
      email: "gestora@a.com.br",
      password: "x",
      role: "BUSINESS_ADMIN",
      businessId: CARRIER,
      access_revoked: false,
    } as User,
    {
      id: OTHER_ADMIN,
      name: "Outro Gestor",
      email: "gestor@b.com.br",
      password: "x",
      role: "BUSINESS_ADMIN",
      businessId: OTHER_CARRIER,
      access_revoked: false,
    } as User,
    {
      id: DRIVER_LOGIN,
      name: "Maria Prado",
      email: null,
      password: "x",
      role: "BUSINESS_USER",
      businessId: CARRIER,
      driverId: "018f3800-0000-7000-8000-0000000000e1",
      access_revoked: false,
    } as User,
  );

  for (const phone of [PHONE, OTHER_PHONE]) {
    await trusted.trust({
      userId: DRIVER_LOGIN,
      deviceHash: hashDeviceId(phone),
      source: "qr",
    });
  }
});

describe("the manager disconnecting a driver's phone", () => {
  it("ends its sessions and removes its trust, leaving the other phone", async () => {
    await tokens.createUserRefreshToken({
      userId: DRIVER_LOGIN,
      token_hash: "phone-session",
      jti: "phone-jti",
      family_id: "phone-family",
      expires_in: new Date(Date.now() + 60_000),
      device_id: PHONE,
    });

    await revoke().execute({
      actorId: ADMIN,
      userId: DRIVER_LOGIN,
      deviceHash: hashDeviceId(PHONE),
    });

    expect(tokens.refreshTokenItems).toEqual([]);
    expect(realtime.sessionEvents).toEqual([
      { sessionId: "phone-family", reason: "device_revoked" },
    ]);
    expect(
      (await trusted.listForUser(DRIVER_LOGIN)).map((row) => row.device_hash),
    ).toEqual([hashDeviceId(OTHER_PHONE)]);
  });

  it("removes the trust of a phone with no session left, and records it", async () => {
    await revoke().execute({
      actorId: ADMIN,
      userId: DRIVER_LOGIN,
      deviceHash: hashDeviceId(PHONE),
    });

    expect(await trusted.listForUser(DRIVER_LOGIN)).toHaveLength(1);
    expect(activities).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: DRIVER_LOGIN, performedBy: ADMIN }),
    );
  });

  it("makes the QR code spent on that phone forget it, and only that phone", async () => {
    await qrSpentOn(PHONE);

    await revoke().execute({
      actorId: ADMIN,
      userId: DRIVER_LOGIN,
      deviceHash: hashDeviceId(OTHER_PHONE),
    });

    expect((await enrollment.findByUserId(DRIVER_LOGIN))?.device_id).toBe(
      PHONE,
    );

    await revoke().execute({
      actorId: ADMIN,
      userId: DRIVER_LOGIN,
      deviceHash: hashDeviceId(PHONE),
    });

    expect(await enrollment.findByUserId(DRIVER_LOGIN)).toMatchObject({
      consumed_at: expect.any(Date),
      device_id: null,
      createdById: ADMIN,
    });
  });

  it("does nothing, and records nothing, for a phone it never had", async () => {
    await revoke().execute({
      actorId: ADMIN,
      userId: DRIVER_LOGIN,
      deviceHash: hashDeviceId("1111111111111111"),
    });

    expect(await trusted.listForUser(DRIVER_LOGIN)).toHaveLength(2);
    expect(activities).not.toHaveBeenCalled();
  });

  it("answers another company's manager like a missing driver (404), touching nothing", async () => {
    await expect(
      revoke().execute({
        actorId: OTHER_ADMIN,
        userId: DRIVER_LOGIN,
        deviceHash: hashDeviceId(PHONE),
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: "USER_NOT_FOUND" });

    expect(await trusted.listForUser(DRIVER_LOGIN)).toHaveLength(2);
  });
});

/**
 * Since wave 2 the phone's id is what the CPF login checks the phone by,
 * and the list is open to a profile that may only read users: it names each
 * phone by its hash, and that hash is what the manager disconnects it by.
 */
describe("the manager's list of a driver's phones", () => {
  it("names each phone by its hash, never its id, and disconnects it by that hash", async () => {
    await tokens.createUserRefreshToken({
      userId: DRIVER_LOGIN,
      token_hash: "phone-session",
      jti: "phone-jti",
      family_id: "phone-family",
      expires_in: new Date(Date.now() + 60_000),
      device_id: PHONE,
    });

    const listed = await new ListDriverDevicesUseCase(users, tokens).execute({
      actorId: ADMIN,
      userId: DRIVER_LOGIN,
    });

    expect(listed).toEqual([
      expect.objectContaining({
        device_hash: hashDeviceId(PHONE),
        sessions: 1,
      }),
    ]);
    expect(JSON.stringify(listed)).not.toContain(PHONE);

    await revoke().execute({
      actorId: ADMIN,
      userId: DRIVER_LOGIN,
      deviceHash: listed[0].device_hash,
    });

    expect(tokens.refreshTokenItems).toEqual([]);
    expect(
      (await trusted.listForUser(DRIVER_LOGIN)).map((row) => row.device_hash),
    ).toEqual([hashDeviceId(OTHER_PHONE)]);
  });
});

describe("the phone in DELETE /user/:userId/devices/:deviceId", () => {
  const parse = (deviceId: string) =>
    driverDeviceParamsSchema.safeParse({ userId: DRIVER_LOGIN, deviceId });

  it("takes the list's hash, in either case", () => {
    const hash = hashDeviceId(PHONE);

    expect(parse(hash.toUpperCase())).toMatchObject({
      success: true,
      data: { deviceId: hash },
    });
  });

  // A page the web loaded before the list stopped giving the id.
  it("still takes the phone's id, as its hash", () => {
    expect(parse(PHONE.toUpperCase())).toMatchObject({
      success: true,
      data: { deviceId: hashDeviceId(PHONE) },
    });
  });

  it("refuses anything else", () => {
    for (const junk of ["", "abc", "z".repeat(64), "1".repeat(65)]) {
      expect(parse(junk).success, junk).toBe(false);
    }
  });
});
