import "reflect-metadata";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { decode } from "jsonwebtoken";
import { v7 as uuidV7 } from "uuid";

/**
 * Creating a password right after the manager's QR code, without the current
 * one (wave 2, 06/11/2026; owner's decision: "esqueci a senha" without e-mail
 * is a new QR code, then the driver creates the password at once).
 *
 * Only the session the QR opened may do it: on the phone that read it, within
 * fifteen minutes, a session that began with it. It keeps that session and
 * ends the others, clears the lock and the manager's "create your own" flag,
 * and the company's admins hear it — all in the password's write.
 */
const realtime = vi.hoisted(() => ({
  sessionEvents: [] as Array<{ sessionId: string; reason: string }>,
  adopted: [] as Array<{ sessionId: string; version: number }>,
}));

const mails = vi.hoisted(() => [] as string[]);

vi.mock("@/websocket", () => ({
  sendSecurityEventToSession: (
    sessionId: string,
    payload: { reason: string },
  ) => {
    realtime.sessionEvents.push({ sessionId, reason: payload.reason });
  },
  adoptSessionVersion: (sessionId: string, version: number) => {
    realtime.adopted.push({ sessionId, version });
  },
}));

vi.mock("@/shared/services/transactional-mail-service", () => ({
  sendTransactionalMail: async ({ templateName }: { templateName: string }) => {
    mails.push(templateName);
  },
}));

import type { User } from "@/modules/user/dtos/user-dto";
import type { NotificationService } from "@/shared/services/notification-service";
import type { OutboxService } from "@/shared/notifications/outbox-service";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryUserTokensRepository } from "@/modules/user/repositories/in-memory/in-memory-user-tokens-repository";
import { InMemoryDriverEnrollmentRepository } from "@/modules/user/repositories/in-memory/in-memory-driver-enrollment-repository";

import {
  CREATE_AFTER_QR_WINDOW_MS,
  CreateOwnPasswordUseCase,
} from "@/modules/user/usecases/create-own-password/create-own-password-usecase";
import {
  hashDeviceId,
  hashRefreshToken,
} from "@/modules/user/services/session-service";
import { hashSingleUseToken } from "@/shared/security/single-use-token";
import { compareSecret } from "@/shared/security/bcrypt-gate";

const CARRIER = "018f3500-0000-7000-8000-00000000000a";
const DRIVER_LOGIN = "018f3500-0000-7000-8000-0000000000a1";
const MANAGER = "018f3500-0000-7000-8000-0000000000a2";
const PHONE = "23be03c084165505";
const OTHER_PHONE = "9f1c03c084160000";
const NEW_PASSWORD = "minha-senha-77";
const MINUTE = 60 * 1000;

let users: InMemoryUserRepository;
let tokens: InMemoryUserTokensRepository;
let enrollment: InMemoryDriverEnrollmentRepository;
const publish = vi.fn(async () => undefined);
const activities = vi.fn();

const useCase = () =>
  new CreateOwnPasswordUseCase(
    users,
    tokens,
    enrollment,
    { publish } as unknown as OutboxService,
    { createActivityIfEnabled: activities } as unknown as NotificationService,
  );

/** The manager's QR code, read by `deviceId` at `consumedAt`. */
async function qrRead(deviceId: string, consumedAt: Date) {
  const row = await enrollment.issue({
    userId: DRIVER_LOGIN,
    businessId: CARRIER,
    token: `qr-${uuidV7()}`,
    code: null,
    expiresAt: new Date(consumedAt.getTime() + 10 * MINUTE),
    createdById: MANAGER,
  });

  await enrollment.consume(row.id, {
    tokenHash: row.token_hash,
    deviceId,
    now: consumedAt,
    maxAttempts: 5,
  });
}

/** A session of the driver, its first row issued at `issuedAt`. */
async function session(
  issuedAt: Date,
  options: { deviceId?: string | null; revoked?: boolean } = {},
): Promise<string> {
  const familyId = uuidV7({ msecs: issuedAt.getTime() });
  const row = await tokens.createUserRefreshToken({
    userId: DRIVER_LOGIN,
    token_hash: hashSingleUseToken(familyId),
    jti: uuidV7(),
    family_id: familyId,
    expires_in: new Date(issuedAt.getTime() + 30 * 24 * 60 * MINUTE),
    device_id: options.deviceId === undefined ? PHONE : options.deviceId,
  });

  row.created_at = issuedAt;
  if (options.revoked) row.revoked_at = new Date();

  return familyId;
}

const create = (sessionId: string) =>
  useCase().execute({
    userId: DRIVER_LOGIN,
    sessionId,
    password: NEW_PASSWORD,
    client: "mobile",
  });

beforeEach(() => {
  realtime.sessionEvents.length = 0;
  realtime.adopted.length = 0;
  mails.length = 0;
  publish.mockClear();
  activities.mockClear();

  tokens = new InMemoryUserTokensRepository();
  users = new InMemoryUserRepository({ tokens });
  enrollment = new InMemoryDriverEnrollmentRepository();

  users.user.push({
    id: DRIVER_LOGIN,
    name: "Maria Prado",
    email: null,
    password: "hash-antigo",
    role: "BUSINESS_USER",
    businessId: CARRIER,
    driverId: "018f3500-0000-7000-8000-0000000000d1",
    access_revoked: false,
    session_version: 2,
    must_change_password: true,
    failed_login_attempts: 9,
    login_locked_until: new Date(Date.now() + 10 * MINUTE),
  } as User);
});

describe("right after the QR code, in the session it opened", () => {
  it("sets the password, keeps this session bound to the phone and ends the others", async () => {
    const consumedAt = new Date(Date.now() - 5 * MINUTE);
    await qrRead(PHONE, consumedAt);

    const older = await session(new Date(Date.now() - 3 * 24 * 60 * MINUTE), {
      deviceId: OTHER_PHONE,
    });
    const mine = await session(new Date(consumedAt.getTime() + 1000));

    const result = await create(mine);

    expect(result).toMatchObject({
      token: expect.any(String),
      refresh_token: expect.any(String),
      mustChangePassword: false,
    });
    expect(decode(result.refresh_token)).toMatchObject({
      sub: DRIVER_LOGIN,
      familyId: mine,
      sessionVersion: 3,
      sessionClient: "driver_device",
      deviceHash: hashDeviceId(PHONE),
    });
    expect(
      tokens.refreshTokenItems.find((row) => !row.revoked_at)?.token_hash,
    ).toBe(hashRefreshToken(result.refresh_token));
    expect(
      tokens.refreshTokenItems.some((row) => row.family_id === older),
    ).toBe(false);
    expect(realtime.sessionEvents).toEqual([
      { sessionId: older, reason: "password_changed" },
    ]);
    expect(realtime.adopted).toEqual([{ sessionId: mine, version: 3 }]);

    const row = users.user[0];
    await expect(compareSecret(NEW_PASSWORD, row.password)).resolves.toBe(true);
    expect(row).toMatchObject({
      must_change_password: false,
      failed_login_attempts: 0,
      login_locked_until: null,
    });
  });

  // A code read out over the phone to somebody posing as the driver is how
  // the account would be taken: the admins hear it, all but the manager who
  // issued the code, in the password's transaction.
  it("tells the company's admins, records the activity, and mails nobody without a mailbox", async () => {
    const consumedAt = new Date(Date.now() - MINUTE);
    await qrRead(PHONE, consumedAt);
    const mine = await session(new Date(consumedAt.getTime() + 500));

    await create(mine);

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        topic: "driver-access.password_created",
        businessId: CARRIER,
        actorId: DRIVER_LOGIN,
        payload: expect.objectContaining({
          businessId: CARRIER,
          driverUserId: DRIVER_LOGIN,
          driverName: "Maria Prado",
          issuedById: MANAGER,
        }),
      }),
    );
    expect(activities).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: DRIVER_LOGIN,
        performedBy: DRIVER_LOGIN,
        businessId: CARRIER,
        description: expect.stringContaining("depois do QR Code"),
      }),
    );
    expect(mails).toEqual([]);
    expect(JSON.stringify(publish.mock.calls)).not.toContain(NEW_PASSWORD);
  });

  it("mails the notice when there is a mailbox", async () => {
    users.user[0].email = "maria@exemplo.com.br";
    const consumedAt = new Date(Date.now() - MINUTE);
    await qrRead(PHONE, consumedAt);

    await create(await session(new Date(consumedAt.getTime() + 500)));

    expect(mails).toEqual(["user-password-updated.hbs"]);
  });
});

describe("anything else", () => {
  const refusal = { statusCode: 403, code: "PASSWORD_CREATE_NOT_ALLOWED" };

  const expectRefused = async (sessionId: string) => {
    await expect(create(sessionId)).rejects.toMatchObject(refusal);

    expect(users.user[0].password).toBe("hash-antigo");
    expect(users.user[0].must_change_password).toBe(true);
    expect(publish).not.toHaveBeenCalled();
  };

  it("refuses once the window is over", async () => {
    const consumedAt = new Date(
      Date.now() - CREATE_AFTER_QR_WINDOW_MS - MINUTE,
    );
    await qrRead(PHONE, consumedAt);

    await expectRefused(await session(new Date(consumedAt.getTime() + 1000)));
  });

  // Another session of the same phone, from before the QR code: not the
  // one the code opened.
  it("refuses a session that existed before the QR code", async () => {
    const consumedAt = new Date(Date.now() - 2 * MINUTE);
    await qrRead(PHONE, consumedAt);

    await expectRefused(await session(new Date(Date.now() - 60 * MINUTE)));
  });

  it("refuses a session of another phone", async () => {
    const consumedAt = new Date(Date.now() - 2 * MINUTE);
    await qrRead(PHONE, consumedAt);

    await expectRefused(
      await session(new Date(consumedAt.getTime() + 1000), {
        deviceId: OTHER_PHONE,
      }),
    );
  });

  it("refuses a session bound to no phone (the web, the app by e-mail)", async () => {
    const consumedAt = new Date(Date.now() - 2 * MINUTE);
    await qrRead(PHONE, consumedAt);

    await expectRefused(
      await session(new Date(consumedAt.getTime() + 1000), { deviceId: null }),
    );
  });

  it("refuses without a QR code read", async () => {
    await enrollment.issue({
      userId: DRIVER_LOGIN,
      businessId: CARRIER,
      token: "qr-ainda-na-tela",
      code: null,
      expiresAt: new Date(Date.now() + 10 * MINUTE),
      createdById: MANAGER,
    });

    await expectRefused(await session(new Date(Date.now() - 1000)));
  });

  it("refuses a session that already ended", async () => {
    const consumedAt = new Date(Date.now() - 2 * MINUTE);
    await qrRead(PHONE, consumedAt);

    await expectRefused(
      await session(new Date(consumedAt.getTime() + 1000), { revoked: true }),
    );
  });

  // The check runs outside the password's write, and a bcrypt sits between
  // them: the manager's "Revogar este aparelho" landing there used to be
  // undone — the write stored a new token in the ended session and answered
  // it, so the disconnected phone kept a fresh session.
  it("refuses a session that ends between its check and the write, and brings nothing back", async () => {
    const consumedAt = new Date(Date.now() - 2 * MINUTE);
    await qrRead(PHONE, consumedAt);
    const mine = await session(new Date(consumedAt.getTime() + 1000));

    const check = tokens.findSessionFamily.bind(tokens);
    vi.spyOn(tokens, "findSessionFamily").mockImplementationOnce(
      async (...args) => {
        const family = await check(...args);

        await tokens.revokeUserRefreshTokenFamily(mine);

        return family;
      },
    );

    await expectRefused(mine);

    expect(users.user[0].session_version).toBe(2);
    expect(tokens.refreshTokenItems).toEqual([]);
    expect(realtime.adopted).toEqual([]);
    expect(activities).not.toHaveBeenCalled();
  });

  it("refuses a caller that no longer exists (404)", async () => {
    await expect(
      useCase().execute({
        userId: uuidV7(),
        sessionId: uuidV7(),
        password: NEW_PASSWORD,
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: "USER_NOT_FOUND" });
  });
});
