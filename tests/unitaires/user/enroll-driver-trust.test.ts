import "reflect-metadata";

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The QR code trusts the phone it is read on (wave 2, 06/11/2026; owner's
 * decision: CPF and password only on a phone that entered the login by QR).
 *
 * A phone new to the login is told to the company's admins — in the same
 * transaction as the trust — and recorded in the login's activity; a phone
 * the login already trusted just signs in again. The answer says whether the
 * manager set the password, so the app asks for the driver's own.
 */
vi.mock("@/../infra/database", () => ({
  default: {
    $transaction: async (run: (tx: unknown) => Promise<unknown>) =>
      run({ transaction: true }),
  },
}));

import type { User } from "@/modules/user/dtos/user-dto";
import type { NotificationService } from "@/shared/services/notification-service";
import type { OutboxService } from "@/shared/notifications/outbox-service";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryUserTokensRepository } from "@/modules/user/repositories/in-memory/in-memory-user-tokens-repository";
import { InMemoryDriverEnrollmentRepository } from "@/modules/user/repositories/in-memory/in-memory-driver-enrollment-repository";
import { InMemoryDriverTrustedDeviceRepository } from "@/modules/user/repositories/in-memory/in-memory-driver-trusted-device-repository";
import { InMemoryDriverRepository } from "@/modules/driver/repositories/in-memory/in-memory-driver-repository";

import { EnrollDriverSessionUseCase } from "@/modules/user/usecases/enroll-driver-session/enroll-driver-session-usecase";
import { hashDeviceId } from "@/modules/user/services/session-service";

const CARRIER = "018f3600-0000-7000-8000-00000000000a";
const DRIVER_LOGIN = "018f3600-0000-7000-8000-0000000000a1";
const DRIVER = "018f3600-0000-7000-8000-0000000000d1";
const MANAGER = "018f3600-0000-7000-8000-0000000000a2";
const PHONE = "23be03c084165505";

let users: InMemoryUserRepository;
let tokens: InMemoryUserTokensRepository;
let enrollment: InMemoryDriverEnrollmentRepository;
let trusted: InMemoryDriverTrustedDeviceRepository;
const publish = vi.fn(async () => undefined);
const activities = vi.fn();

const useCase = () =>
  new EnrollDriverSessionUseCase(
    users,
    tokens,
    new InMemoryDriverRepository(),
    enrollment,
    trusted,
    { publish } as unknown as OutboxService,
    { createActivityIfEnabled: activities } as unknown as NotificationService,
  );

let qr = 0;

async function readQr(deviceId = PHONE) {
  qr += 1;
  const token = `qr-token-${qr}`;

  await enrollment.issue({
    userId: DRIVER_LOGIN,
    businessId: CARRIER,
    token,
    code: null,
    expiresAt: new Date(Date.now() + 10 * 60_000),
    createdById: MANAGER,
  });

  return useCase().execute({ qrToken: token, deviceId });
}

beforeEach(() => {
  publish.mockClear();
  activities.mockClear();

  tokens = new InMemoryUserTokensRepository();
  users = new InMemoryUserRepository({ tokens });
  enrollment = new InMemoryDriverEnrollmentRepository();
  trusted = new InMemoryDriverTrustedDeviceRepository();

  users.businesses.set(CARRIER, { is_active: true, entitlements: [] });
  users.drivers.set(DRIVER, {
    id: DRIVER,
    status: "ACTIVE",
    businessId: CARRIER,
    branchId: null,
    branch: null,
  });
  users.user.push({
    id: DRIVER_LOGIN,
    name: "Maria Prado",
    email: null,
    password: "x",
    role: "BUSINESS_USER",
    businessId: CARRIER,
    driverId: DRIVER,
    access_revoked: false,
    session_version: 0,
    must_change_password: true,
  } as User);
});

describe("a QR code read on a phone new to the login", () => {
  it("trusts the phone, by its hash only, and opens the phone-bound session", async () => {
    const session = await readQr();

    expect(session).toMatchObject({
      token: expect.any(String),
      refresh_token: expect.any(String),
      mustChangePassword: true,
    });
    expect(trusted.devices).toEqual([
      expect.objectContaining({
        userId: DRIVER_LOGIN,
        device_hash: hashDeviceId(PHONE),
        source: "qr",
      }),
    ]);
    expect(JSON.stringify(trusted.devices)).not.toContain(PHONE);
  });

  it("tells the company's admins in the trust's transaction, naming the manager who issued it", async () => {
    await readQr();

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(
      { transaction: true },
      expect.objectContaining({
        topic: "driver-access.new_device",
        aggregateId: DRIVER_LOGIN,
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
    // No phone id in the notice either.
    expect(JSON.stringify(publish.mock.calls)).not.toContain(PHONE);
  });

  it("records it in the login's activity", async () => {
    await readQr();

    expect(activities).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: DRIVER_LOGIN,
        performedBy: DRIVER_LOGIN,
        businessId: CARRIER,
        description: expect.stringContaining("aparelho novo"),
      }),
    );
  });
});

describe("a QR code read again on a phone the login trusts", () => {
  it("signs in with no notice and no new trust row", async () => {
    await readQr();
    publish.mockClear();
    activities.mockClear();

    await readQr();

    expect(trusted.devices).toHaveLength(1);
    expect(publish).not.toHaveBeenCalled();
    expect(activities).not.toHaveBeenCalled();
  });
});

describe("a QR code refused", () => {
  it("trusts nothing", async () => {
    await expect(
      useCase().execute({ qrToken: "desconhecido", deviceId: PHONE }),
    ).rejects.toMatchObject({
      statusCode: 401,
      code: "AUTH_ENROLLMENT_INVALID",
    });

    expect(trusted.devices).toEqual([]);
    expect(publish).not.toHaveBeenCalled();
  });
});
