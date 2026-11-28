import "reflect-metadata";

import { decode } from "jsonwebtoken";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A renewal racing the password change that keeps the session (wave 2).
 *
 * The change re-issues the caller's session in its transaction. A renewal
 * of that same session — the app's automatic one, another tab — that read
 * the user before the change committed (same session_version) and rotates
 * after it must end as a plain 401 for that request. It used to find the
 * session's live row revoked without `replaced_by_jti`, read it as a spent
 * token presented again, and ring the reuse alarm: every session of the
 * account ended, the one the change had just handed back included, under
 * `session_compromised`.
 */
const realtime = vi.hoisted(() => ({
  userEvents: [] as string[],
  sessionEvents: [] as Array<{ sessionId: string; reason: string }>,
}));

vi.mock("@/websocket", () => ({
  sendSecurityEventToUser: (_userId: string, event: { reason: string }) => {
    realtime.userEvents.push(event.reason);
  },
  sendSecurityEventToSession: (
    sessionId: string,
    payload: { reason: string },
  ) => {
    realtime.sessionEvents.push({ sessionId, reason: payload.reason });
  },
  adoptSessionVersion: () => undefined,
}));

import type { User } from "@/modules/user/dtos/user-dto";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryUserTokensRepository } from "@/modules/user/repositories/in-memory/in-memory-user-tokens-repository";

import { setPasswordKeepingSession } from "@/modules/user/services/password-session";
import { createUserSession } from "@/modules/user/services/session-service";
import { RefreshTokenUseCase } from "@/modules/user/usecases/refresh-token/refresh-token-usecase";

const PHONE = "23be03c084165505";

let users: InMemoryUserRepository;
let tokens: InMemoryUserTokensRepository;
let userId: string;

const driverRepositoryStub = { findDriverById: async () => null };

const refresh = () =>
  new RefreshTokenUseCase(users, tokens, driverRepositoryStub as never);

const familyOf = (refreshToken: string) =>
  (decode(refreshToken) as { familyId: string }).familyId;

beforeEach(async () => {
  realtime.userEvents.length = 0;
  realtime.sessionEvents.length = 0;

  tokens = new InMemoryUserTokensRepository();
  users = new InMemoryUserRepository({ tokens });

  // An administrator: eligible for a session without a profile or a driver
  // to stub, and the policy rides in the token either way.
  const user = await users.createUser({
    email: null,
    name: "Pessoa",
    role: "BUSINESS_ADMIN",
    password: "senha-antiga",
    businessId: "018f3900-0000-7000-8000-00000000000a",
  } as never);

  userId = user.id;
});

async function changePasswordKeeping(refreshToken: string) {
  const family = await tokens.findSessionFamily(userId, familyOf(refreshToken));

  return setPasswordKeepingSession(users, {
    userId,
    passwordHash: "hash-da-senha-nova",
    family: family!,
    client: "mobile",
  });
}

describe("a renewal racing the password change that keeps the session", () => {
  it("is a plain 401 for that request: no reuse alarm, the kept session goes on", async () => {
    const before = (await users.findUserById(userId)) as User;
    const phone = await createUserSession(
      before,
      tokens,
      "driver_device",
      PHONE,
    );
    const browser = await createUserSession(before, tokens, "web");

    // The renewal read the user before the change committed.
    const staleRead = { ...before };

    const kept = await changePasswordKeeping(phone.refresh_token);

    vi.spyOn(users, "findUserById").mockResolvedValueOnce(staleRead);

    await expect(
      refresh().execute(phone.refresh_token, PHONE),
    ).rejects.toMatchObject({
      statusCode: 401,
      code: "AUTH_SESSION_INVALIDATED",
    });

    expect(realtime.userEvents).not.toContain("session_compromised");

    // The pair the change answered with still renews.
    await expect(
      refresh().execute(kept.refresh_token, PHONE),
    ).resolves.toMatchObject({ refresh_token: expect.any(String) });

    // And only the other session heard about the change.
    expect(realtime.sessionEvents).toEqual([
      {
        sessionId: familyOf(browser.refresh_token),
        reason: "password_changed",
      },
    ]);
  });

  it("keeps the session's spent rows, and drops only its live one", async () => {
    const before = (await users.findUserById(userId)) as User;
    const phone = await createUserSession(
      before,
      tokens,
      "driver_device",
      PHONE,
    );
    const renewed = await refresh().execute(phone.refresh_token, PHONE);

    await changePasswordKeeping(renewed.refresh_token);

    const rows = tokens.refreshTokenItems.filter(
      (row) => row.family_id === familyOf(phone.refresh_token),
    );

    // The login's spent row, and the re-issued one; the renewal's live row
    // is gone.
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => !row.revoked_at)).toHaveLength(1);
    expect(rows.every((row) => row.device_id === PHONE)).toBe(true);
  });
});
