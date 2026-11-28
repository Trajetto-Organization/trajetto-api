import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import { sign } from "jsonwebtoken";

import auth from "@/config/auth";
import { createPrismaClient } from "@/shared/database/database-client";

import {
  freshAddress,
  openSession,
  seedCarrier,
  seedLogin,
} from "./support/driver-access-seed";

/**
 * POST /user/session/revoke (plan of 02/11/2026, A3), through the whole stack.
 *
 * The app's logout was best effort: it needed a live access token, so a
 * driver who logged out in airplane mode left the session — and the push
 * devices it registered — alive on the server for days, and the phone kept
 * showing the previous person's chat messages. The app now keeps the refresh
 * token of a logout it could not send and calls this route when the network
 * comes back. Asserted on the tables, because the tables are what the refresh
 * and the push pipeline read.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

let CARRIER = "";
const everyone: string[] = [];

const address = () => freshAddress("10.82");

const revoke = (token: unknown, remoteAddress = address()) =>
  app.inject({
    method: "POST",
    url: "/user/session/revoke",
    remoteAddress,
    payload: { token },
  });

async function person(): Promise<string> {
  const id = await seedLogin(prisma, {
    businessId: CARRIER,
    role: "BUSINESS_ADMIN",
  });

  everyone.push(id);

  return id;
}

async function registerPush(userId: string, familyId: string): Promise<string> {
  const token = `ExponentPushToken[${randomUUID()}]`;

  await prisma.pushDeviceToken.create({
    data: { userId, token, platform: "android", session_family_id: familyId },
  });

  return token;
}

const liveRows = (familyId: string) =>
  prisma.refreshToken.count({ where: { family_id: familyId } });

beforeAll(async () => {
  CARRIER = await seedCarrier(prisma);

  ({ app } = await import("@/http"));
  await app.ready();
}, 90_000);

afterAll(async () => {
  await prisma.pushDeviceToken.deleteMany({
    where: { userId: { in: everyone } },
  });
  await prisma.refreshToken.deleteMany({
    where: { userId: { in: everyone } },
  });
  await prisma.user.deleteMany({ where: { id: { in: everyone } } });
  await prisma.business.deleteMany({ where: { id: CARRIER } });

  await app?.close();
  await prisma.$disconnect();
});

describe("revoking a session with its refresh token", () => {
  it("ends that session and unregisters the devices it registered", async () => {
    const userId = await person();
    const session = await openSession(prisma, userId);
    const push = await registerPush(userId, session.familyId);

    const response = await revoke(session.refresh);

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe("");
    expect(await liveRows(session.familyId)).toBe(0);
    expect(await prisma.pushDeviceToken.count({ where: { token: push } })).toBe(
      0,
    );

    // The access token of that session is over too.
    const me = await app.inject({
      method: "GET",
      url: "/user/me",
      remoteAddress: address(),
      headers: { authorization: `Bearer ${session.access}` },
    });

    expect(me.statusCode).toBe(401);
    expect(me.json().code).toBe("AUTH_SESSION_INVALIDATED");
  });

  it("leaves the person's other sessions, and other people's, alone", async () => {
    const userId = await person();
    const phone = await openSession(prisma, userId);
    const browser = await openSession(prisma, userId);
    const someoneElse = await openSession(prisma, await person());
    const browserPush = await registerPush(userId, browser.familyId);

    expect((await revoke(phone.refresh)).statusCode).toBe(204);

    expect(await liveRows(browser.familyId)).toBe(1);
    expect(await liveRows(someoneElse.familyId)).toBe(1);
    expect(
      await prisma.pushDeviceToken.count({ where: { token: browserPush } }),
    ).toBe(1);
  });

  it("answers 204 again for a session already over", async () => {
    const session = await openSession(prisma, await person());

    expect((await revoke(session.refresh)).statusCode).toBe(204);
    expect((await revoke(session.refresh)).statusCode).toBe(204);
  });

  it("takes a token already rotated (or reused): it still names its session", async () => {
    const userId = await person();
    const session = await openSession(prisma, userId);

    const rotated = await app.inject({
      method: "POST",
      url: "/user/refresh-token",
      remoteAddress: address(),
      payload: { token: session.refresh },
    });

    expect(rotated.statusCode).toBe(200);
    expect(await liveRows(session.familyId)).toBe(2);

    // The OLD token, the one the app kept when the logout failed.
    expect((await revoke(session.refresh)).statusCode).toBe(204);
    expect(await liveRows(session.familyId)).toBe(0);

    const renewed = await app.inject({
      method: "POST",
      url: "/user/refresh-token",
      remoteAddress: address(),
      payload: { token: rotated.json().refresh_token },
    });

    expect(renewed.statusCode).toBe(401);
  });

  it("takes an expired token: its session is ended now, not at the nightly purge", async () => {
    const userId = await person();
    const familyId = randomUUID();
    const push = await registerPush(userId, familyId);

    await prisma.refreshToken.create({
      data: {
        userId,
        token_hash: randomUUID(),
        jti: randomUUID(),
        family_id: familyId,
        expires_in: new Date(Date.now() - 60_000),
      },
    });

    const expired = sign(
      {
        tokenType: "refresh",
        sessionVersion: 0,
        familyId,
        sessionClient: "mobile",
        exp: Math.floor(Date.now() / 1000) - 60,
      },
      auth.secret_refresh_token,
      { subject: userId, jwtid: randomUUID() },
    );

    expect((await revoke(expired)).statusCode).toBe(204);
    expect(await liveRows(familyId)).toBe(0);
    expect(await prisma.pushDeviceToken.count({ where: { token: push } })).toBe(
      0,
    );
  });
});

describe("what it refuses", () => {
  it("a token this API did not sign, or one that is not a refresh token", async () => {
    const session = await openSession(prisma, await person());

    const forged = sign(
      { tokenType: "refresh", sessionVersion: 0, familyId: session.familyId },
      "another-secret-that-is-not-ours-0123456789",
      { subject: randomUUID(), jwtid: randomUUID() },
    );

    for (const token of [forged, session.access, "garbage"]) {
      const response = await revoke(token);

      expect(response.statusCode, token.slice(0, 12)).toBe(401);
      expect(response.json().code).toBe("AUTH_REFRESH_INVALID");
    }

    // Nothing was ended by any of them.
    expect(await liveRows(session.familyId)).toBe(1);
  });

  it("a body without a token", async () => {
    const response = await revoke(undefined);

    expect(response.statusCode).toBe(400);
  });

  it("more than ten calls a minute for one session", async () => {
    const session = await openSession(prisma, await person());
    const statuses: number[] = [];

    // Counted per session, whatever the address (refreshSessionRateLimitKey).
    for (let call = 0; call < 11; call += 1) {
      statuses.push((await revoke(session.refresh)).statusCode);
    }

    expect(statuses.slice(0, 10).every((status) => status === 204)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});
