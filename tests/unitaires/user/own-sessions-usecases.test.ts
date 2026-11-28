import "reflect-metadata";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { v7 as uuidV7 } from "uuid";

/**
 * "Aparelhos conectados" (wave 2, 06/11/2026): the person lists their own
 * sessions and ends the others. A phone-bound session takes the phone's trust
 * with it — unless another session of the person is still on that phone, the
 * one asking included; the session asking is never ended here (the logout is
 * its way out); nobody else's session, nor one already over, can be touched.
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
  ListOwnSessionsUseCase,
  RevokeOwnSessionUseCase,
} from "@/modules/user/usecases/own-sessions/own-sessions-usecases";
import { hashDeviceId } from "@/modules/user/services/session-service";

const PERSON = "018f3400-0000-7000-8000-0000000000a1";
const STRANGER = "018f3400-0000-7000-8000-0000000000b1";
const PHONE = "23be03c084165505";
const DAY = 24 * 60 * 60 * 1000;

let users: InMemoryUserRepository;
let tokens: InMemoryUserTokensRepository;
let trusted: InMemoryDriverTrustedDeviceRepository;
let enrollment: InMemoryDriverEnrollmentRepository;
const activities = vi.fn();
const notifications = {
  createActivityIfEnabled: activities,
} as unknown as NotificationService;

const list = () => new ListOwnSessionsUseCase(users, tokens);
const revoke = () =>
  new RevokeOwnSessionUseCase(
    users,
    tokens,
    trusted,
    enrollment,
    notifications,
  );

/** The manager's QR code, spent by `deviceId`. */
async function qrSpentOn(userId: string, deviceId: string) {
  const row = await enrollment.issue({
    userId,
    businessId: "018f3400-0000-7000-8000-00000000000a",
    token: `qr-${uuidV7()}`,
    code: null,
    expiresAt: new Date(Date.now() + 10 * 60_000),
    createdById: null,
  });

  await enrollment.consume(row.id, {
    tokenHash: row.token_hash,
    deviceId,
    maxAttempts: 5,
  });
}

async function session(
  userId: string,
  options: { deviceId?: string; lifetimeMs?: number; agoMs?: number } = {},
): Promise<string> {
  const familyId = uuidV7();
  const createdAt = new Date(Date.now() - (options.agoMs ?? 0));
  const row = await tokens.createUserRefreshToken({
    userId,
    token_hash: `hash-${familyId}`,
    jti: uuidV7(),
    family_id: familyId,
    expires_in: new Date(createdAt.getTime() + (options.lifetimeMs ?? DAY)),
    device_id: options.deviceId ?? null,
  });

  row.created_at = createdAt;

  return familyId;
}

beforeEach(() => {
  realtime.sessionEvents.length = 0;
  activities.mockClear();

  tokens = new InMemoryUserTokensRepository();
  users = new InMemoryUserRepository({ tokens });
  trusted = new InMemoryDriverTrustedDeviceRepository();
  enrollment = new InMemoryDriverEnrollmentRepository();

  users.user.push(
    {
      id: PERSON,
      name: "Maria Prado",
      email: null,
      password: "x",
      role: "BUSINESS_USER",
      businessId: "018f3400-0000-7000-8000-00000000000a",
      driverId: "018f3400-0000-7000-8000-0000000000d1",
      access_revoked: false,
    } as User,
    {
      id: STRANGER,
      name: "Outra Pessoa",
      email: "outra@exemplo.com.br",
      password: "x",
      role: "BUSINESS_USER",
      businessId: "018f3400-0000-7000-8000-00000000000b",
      access_revoked: false,
    } as User,
  );
});

describe("listing your own sessions", () => {
  it("lists every live session, newest activity first, marking this one, with no phone id", async () => {
    const phone = await session(PERSON, {
      deviceId: PHONE,
      lifetimeMs: 30 * DAY,
      agoMs: 60_000,
    });
    const app = await session(PERSON, { lifetimeMs: 7 * DAY, agoMs: 120_000 });
    const browser = await session(PERSON, { agoMs: 180_000 });
    await session(STRANGER);

    const sessions = await list().execute({ userId: PERSON, sessionId: app });

    expect(
      sessions.map(({ id, kind, current, device_label }) => ({
        id,
        kind,
        current,
        device_label,
      })),
    ).toEqual([
      { id: phone, kind: "aparelho", current: false, device_label: null },
      { id: app, kind: "app", current: true, device_label: "Este aparelho" },
      { id: browser, kind: "navegador", current: false, device_label: null },
    ]);
    expect(JSON.stringify(sessions)).not.toContain(PHONE);
  });

  it("refuses a caller that no longer exists (404)", async () => {
    await expect(
      list().execute({ userId: uuidV7(), sessionId: uuidV7() }),
    ).rejects.toMatchObject({ statusCode: 404, code: "USER_NOT_FOUND" });
  });
});

describe("ending one of your sessions", () => {
  it("ends that session and its push devices, and tells its sockets", async () => {
    const mine = await session(PERSON);
    const other = await session(PERSON);
    tokens.pushDeviceTokens.push(
      { userId: PERSON, session_family_id: other },
      { userId: PERSON, session_family_id: mine },
    );

    await revoke().execute({
      userId: PERSON,
      sessionId: mine,
      targetId: other,
    });

    expect(tokens.refreshTokenItems.map((row) => row.family_id)).toEqual([
      mine,
    ]);
    expect(tokens.pushDeviceTokens).toEqual([
      { userId: PERSON, session_family_id: mine },
    ]);
    expect(realtime.sessionEvents).toEqual([
      { sessionId: other, reason: "logout" },
    ]);
    expect(activities).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: PERSON, performedBy: PERSON }),
    );
  });

  // The phone needs a new QR code to sign in by CPF again, as when the
  // manager disconnects it.
  it("takes the phone's trust with a phone-bound session", async () => {
    const mine = await session(PERSON);
    const phone = await session(PERSON, { deviceId: PHONE });
    await trusted.trust({
      userId: PERSON,
      deviceHash: hashDeviceId(PHONE),
      source: "qr",
    });
    await trusted.trust({
      userId: PERSON,
      deviceHash: hashDeviceId("9f1c03c084160000"),
      source: "qr",
    });

    await revoke().execute({
      userId: PERSON,
      sessionId: mine,
      targetId: phone,
    });

    expect(
      (await trusted.listForUser(PERSON)).map((row) => row.device_hash),
    ).toEqual([hashDeviceId("9f1c03c084160000")]);
  });

  // Nothing that vouches for the phone is left: the consumed QR code read
  // on it forgets it too (the password created after the QR reads that row).
  it("makes the QR code spent on that phone forget it", async () => {
    const mine = await session(PERSON);
    const phone = await session(PERSON, { deviceId: PHONE });
    await qrSpentOn(PERSON, PHONE);

    await revoke().execute({
      userId: PERSON,
      sessionId: mine,
      targetId: phone,
    });

    expect(await enrollment.findByUserId(PERSON)).toMatchObject({
      consumed_at: expect.any(Date),
      device_id: null,
    });
  });

  // Two sessions on one phone are ordinary: a logout without signal, or
  // cleared app data, leaves the old one alive, and the Android ID survives
  // a reinstall. Ending the stale one from the phone must not cost the phone
  // its CPF login.
  it("keeps the phone's trust when ending another session of the phone asking", async () => {
    const stale = await session(PERSON, {
      deviceId: PHONE,
      lifetimeMs: 30 * DAY,
      agoMs: DAY,
    });
    const mine = await session(PERSON, { deviceId: PHONE });
    await trusted.trust({
      userId: PERSON,
      deviceHash: hashDeviceId(PHONE),
      source: "qr",
    });
    await qrSpentOn(PERSON, PHONE);

    await revoke().execute({
      userId: PERSON,
      sessionId: mine,
      targetId: stale,
    });

    expect(tokens.refreshTokenItems.map((row) => row.family_id)).toEqual([
      mine,
    ]);
    expect(await trusted.listForUser(PERSON)).toHaveLength(1);
    expect((await enrollment.findByUserId(PERSON))?.device_id).toBe(PHONE);
    expect(realtime.sessionEvents).toEqual([
      { sessionId: stale, reason: "logout" },
    ]);
    expect(activities).toHaveBeenCalledWith(
      expect.objectContaining({
        description: "Sessão de Maria Prado encerrada pelo próprio usuário",
      }),
    );
  });

  it("keeps the phone's trust while another of its sessions is still alive", async () => {
    const mine = await session(PERSON);
    const first = await session(PERSON, {
      deviceId: PHONE,
      lifetimeMs: 30 * DAY,
      agoMs: DAY,
    });
    const second = await session(PERSON, { deviceId: PHONE });
    await trusted.trust({
      userId: PERSON,
      deviceHash: hashDeviceId(PHONE),
      source: "qr",
    });

    await revoke().execute({
      userId: PERSON,
      sessionId: mine,
      targetId: first,
    });

    expect(await trusted.listForUser(PERSON)).toHaveLength(1);

    // The phone's last session: now its trust goes.
    await revoke().execute({
      userId: PERSON,
      sessionId: mine,
      targetId: second,
    });

    expect(await trusted.listForUser(PERSON)).toEqual([]);
  });

  // "Already over" is a session with no live row left: spent or lapsed rows
  // wait for the purge, and touching them must not take the phone's trust.
  it("ends nothing, and keeps the phone's trust, for a session already over", async () => {
    const mine = await session(PERSON);
    const lapsed = await session(PERSON, {
      deviceId: PHONE,
      lifetimeMs: DAY,
      agoMs: 2 * DAY,
    });
    await trusted.trust({
      userId: PERSON,
      deviceHash: hashDeviceId(PHONE),
      source: "qr",
    });

    await revoke().execute({
      userId: PERSON,
      sessionId: mine,
      targetId: lapsed,
    });

    expect(await trusted.listForUser(PERSON)).toHaveLength(1);
    expect(realtime.sessionEvents).toEqual([]);
    expect(activities).not.toHaveBeenCalled();
  });

  it("refuses this session: the logout is its way out (409)", async () => {
    const mine = await session(PERSON);

    await expect(
      revoke().execute({ userId: PERSON, sessionId: mine, targetId: mine }),
    ).rejects.toMatchObject({ statusCode: 409, code: "SESSION_IS_CURRENT" });

    expect(tokens.refreshTokenItems).toHaveLength(1);
  });

  // Scoped by the person: another person's session id ends nothing, and the
  // answer is the same as for one already over (no existence oracle).
  it("ends nothing of somebody else's, and answers like a session already over", async () => {
    const mine = await session(PERSON);
    const theirs = await session(STRANGER, { deviceId: PHONE });
    await trusted.trust({
      userId: STRANGER,
      deviceHash: hashDeviceId(PHONE),
      source: "qr",
    });

    await expect(
      revoke().execute({ userId: PERSON, sessionId: mine, targetId: theirs }),
    ).resolves.toBeUndefined();
    await expect(
      revoke().execute({ userId: PERSON, sessionId: mine, targetId: uuidV7() }),
    ).resolves.toBeUndefined();

    expect(
      tokens.refreshTokenItems.filter((row) => row.userId === STRANGER),
    ).toHaveLength(1);
    expect(await trusted.listForUser(STRANGER)).toHaveLength(1);
    expect(realtime.sessionEvents).toEqual([]);
    expect(activities).not.toHaveBeenCalled();
  });
});
