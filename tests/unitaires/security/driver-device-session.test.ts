import "reflect-metadata";

import { decode } from "jsonwebtoken";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const securityEvents = vi.hoisted(() => [] as string[]);

vi.mock("@/websocket", () => ({
  sendSecurityEventToUser: (_userId: string, event: { reason: string }) => {
    securityEvents.push(event.reason);
  },
}));

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryUserTokensRepository } from "@/modules/user/repositories/in-memory/in-memory-user-tokens-repository";

import {
  createUserSession,
  parseSessionClient,
} from "@/modules/user/services/session-service";
import { RefreshTokenUseCase } from "@/modules/user/usecases/refresh-token/refresh-token-usecase";

/**
 * The driver's phone session (plan of 02/11/2026, D4; decision D03).
 *
 * With the mobile policy (7 idle days, 30 at most) a driver who entered by
 * reading the manager's QR code would have to read a new one every month. A
 * session opened by the QR code, or by CPF and password with the phone's id,
 * now lives 30 idle days and 180 at most — and in exchange it is bound to
 * that phone: every refresh must come from the same device id, and a copy of
 * the refresh token replayed from another phone is refused.
 */
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const PHONE = "23be03c084165505";
const OTHER_PHONE = "9f1c03c084160000";

let users: InMemoryUserRepository;
let tokens: InMemoryUserTokensRepository;
let refresh: RefreshTokenUseCase;
let userId: string;

const driverRepositoryStub = { findDriverById: async () => null };

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-03T08:00:00.400Z"));

  securityEvents.length = 0;
  users = new InMemoryUserRepository();
  tokens = new InMemoryUserTokensRepository();
  refresh = new RefreshTokenUseCase(
    users,
    tokens,
    driverRepositoryStub as never,
  );

  const user = await users.createUser({
    email: "motorista@exemplo.com.br",
    name: "Motorista",
    role: "BUSINESS_ADMIN",
    password: "nao-usado",
    businessId: "business-1",
  } as never);

  userId = user.id;
});

afterEach(() => {
  vi.useRealTimers();
});

async function phoneLogin(deviceId = PHONE): Promise<string> {
  const user = await users.findUserById(userId);
  const session = await createUserSession(
    user!,
    tokens,
    "driver_device",
    deviceId,
  );

  return session.refresh_token;
}

describe("a driver's phone session", () => {
  it("still renews after 29 days without a request", async () => {
    const token = await phoneLogin();

    vi.advanceTimersByTime(29 * DAY);

    await expect(refresh.execute(token, PHONE)).resolves.toMatchObject({
      refresh_token: expect.any(String),
    });
  });

  it("ends after more than 30 idle days", async () => {
    const token = await phoneLogin();

    vi.advanceTimersByTime(30 * DAY + HOUR);

    await expect(refresh.execute(token, PHONE)).rejects.toMatchObject({
      name: "TokenExpiredError",
    });
  });

  it("keeps going for two months of use, up to 180 days from the login", async () => {
    let token = await phoneLogin();

    // Opened every 25 days: still signed in after two months, and after five.
    for (let day = 25; day <= 175; day += 25) {
      vi.advanceTimersByTime(25 * DAY);
      token = (await refresh.execute(token, PHONE)).refresh_token;
    }

    vi.advanceTimersByTime(5 * DAY + HOUR);

    await expect(refresh.execute(token, PHONE)).rejects.toMatchObject({
      name: "TokenExpiredError",
    });

    expect(securityEvents).toEqual([]);
  });

  it("carries the phone to every token of the family", async () => {
    let token = await phoneLogin();

    token = (await refresh.execute(token, PHONE)).refresh_token;
    await refresh.execute(token, PHONE);

    expect(tokens.refreshTokenItems).toHaveLength(3);
    expect(tokens.refreshTokenItems.map((row) => row.device_id)).toEqual([
      PHONE,
      PHONE,
      PHONE,
    ]);
  });

  it("refuses a refresh from another phone, and leaves the session alone", async () => {
    const token = await phoneLogin();

    await expect(refresh.execute(token, OTHER_PHONE)).rejects.toMatchObject({
      statusCode: 401,
      code: "AUTH_DEVICE_MISMATCH",
    });

    // Not spent and not an alarm: the driver's own phone carries on.
    expect(tokens.refreshTokenItems[0].revoked_at).toBeNull();
    expect(securityEvents).toEqual([]);
    await expect(refresh.execute(token, PHONE)).resolves.toMatchObject({
      token: expect.any(String),
    });
  });

  it("refuses a refresh that does not say which phone it comes from", async () => {
    const token = await phoneLogin();

    await expect(refresh.execute(token)).rejects.toMatchObject({
      code: "AUTH_DEVICE_MISMATCH",
    });
    await expect(refresh.execute(token, null)).rejects.toMatchObject({
      code: "AUTH_DEVICE_MISMATCH",
    });
  });

  it("matches the phone whatever the case of its id", async () => {
    const token = await phoneLogin(PHONE.toUpperCase());

    await expect(refresh.execute(token, PHONE)).resolves.toMatchObject({
      token: expect.any(String),
    });
  });

  it("never puts the phone's id itself in the token", async () => {
    const token = await phoneLogin();

    expect(token).not.toContain(PHONE);
    expect(JSON.stringify(decode(token))).not.toContain(PHONE);
  });

  it("cannot be opened without a phone", async () => {
    const user = await users.findUserById(userId);

    await expect(
      createUserSession(user!, tokens, "driver_device", null),
    ).rejects.toThrow();
    expect(tokens.refreshTokenItems).toHaveLength(0);
  });
});

describe("the other sessions", () => {
  it("ignore a phone id sent with the refresh", async () => {
    const user = await users.findUserById(userId);
    const { refresh_token } = await createUserSession(user!, tokens, "mobile");

    await expect(
      refresh.execute(refresh_token, OTHER_PHONE),
    ).resolves.toMatchObject({ token: expect.any(String) });
    expect(tokens.refreshTokenItems.map((row) => row.device_id)).toEqual([
      null,
      null,
    ]);
  });

  it("never get the phone policy from the client header", () => {
    expect(parseSessionClient("driver_device")).toBe("web");
    expect(parseSessionClient("mobile")).toBe("mobile");
  });
});
