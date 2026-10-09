import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { issueSessionTokenPair } from "@/modules/user/services/session-service";

/**
 * A phone's push token lives and dies with the session that registered it
 * (MOB-05).
 *
 * The app's logout fired the push unregister and the server logout side by
 * side. The unregister needs a live session, so whenever the logout's revoke
 * landed first it got a 401 — swallowed — and the Expo token stayed bound to
 * the user: the logged-out phone kept showing their chat messages, with the
 * text, in the notification tray. A forced logout or an offline one never sent
 * the unregister at all. The server did nothing on its side.
 *
 * Asserted on the table, because the table is what the push pipeline reads.
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018fb000-0000-7000-8000-00000000d0a1";
/**
 * Fresh people for every test. The push-token route allows ten calls a
 * minute per USER, and those counters live in Redis across runs: two fixed
 * users hit the ceiling on a second run inside the same minute.
 */
let DRIVER_USER = "";
let NEXT_USER = "";

const everyone: string[] = [];

let next = 1;

/** A fresh address per request: this file is not about the route limits. */
const address = () => `10.79.${Math.floor(next / 250)}.${(next++ % 250) + 1}`;

interface Session {
  access: string;
  familyId: string;
}

async function openSession(userId: string): Promise<Session> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const pair = issueSessionTokenPair(user as never);

  await prisma.refreshToken.create({
    data: {
      userId,
      token_hash: pair.refreshTokenHash,
      jti: pair.refreshJti,
      family_id: pair.familyId,
      expires_in: pair.expiresAt,
    },
  });

  return { access: pair.token, familyId: pair.familyId };
}

const call = (
  method: "POST" | "DELETE",
  url: string,
  session: Session,
  payload?: Record<string, string>,
) =>
  app.inject({
    method,
    url,
    remoteAddress: address(),
    headers: { authorization: `Bearer ${session.access}` },
    ...(payload === undefined ? {} : { payload }),
  });

async function registerDevice(session: Session): Promise<string> {
  const token = `ExponentPushToken[${randomUUID()}]`;

  const response = await call("POST", "/notification/push-token", session, {
    token,
    platform: "android",
  });

  expect(response.statusCode).toBe(200);

  return token;
}

const devicesWith = (token: string) =>
  prisma.pushDeviceToken.count({ where: { token } });

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora do Push",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: "55222888000339",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `push-${randomUUID()}@exemplo.com.br`,
    },
  });

  ({ app } = await import("@/http"));
  await app.ready();
}, 90_000);

beforeEach(async () => {
  DRIVER_USER = randomUUID();
  NEXT_USER = randomUUID();
  everyone.push(DRIVER_USER, NEXT_USER);

  await prisma.user.createMany({
    data: [DRIVER_USER, NEXT_USER].map((id, index) => ({
      id,
      name: `Pessoa ${index + 1}`,
      email: `push-${index}-${randomUUID()}@exemplo.com.br`,
      password: "nao-usado",
      role: "BUSINESS_ADMIN" as const,
      businessId: CARRIER,
      email_verified: new Date(),
    })),
  });
});

afterAll(async () => {
  await prisma.pushDeviceToken.deleteMany({
    where: { userId: { in: everyone } },
  });
  await prisma.refreshToken.deleteMany({
    where: { userId: { in: everyone } },
  });
  await prisma.user.deleteMany({
    where: { id: { in: everyone } },
  });
  await prisma.business.deleteMany({ where: { id: CARRIER } });

  await app?.close();
  await prisma.$disconnect();
}, 60_000);

describe("registering a device", () => {
  it("records which session registered it", async () => {
    const session = await openSession(DRIVER_USER);
    const token = await registerDevice(session);

    const row = await prisma.pushDeviceToken.findUniqueOrThrow({
      where: { token },
    });

    expect(row.session_family_id).toBe(session.familyId);
  });

  it("moves the device to whoever logs in on it next", async () => {
    const first = await openSession(DRIVER_USER);
    const token = await registerDevice(first);

    const second = await openSession(NEXT_USER);

    const response = await call("POST", "/notification/push-token", second, {
      token,
      platform: "android",
    });

    expect(response.statusCode).toBe(200);

    const row = await prisma.pushDeviceToken.findUniqueOrThrow({
      where: { token },
    });

    expect(row.userId).toBe(NEXT_USER);
    expect(row.session_family_id).toBe(second.familyId);
  });
});

describe("logging out", () => {
  it("unregisters the device even when the app's own unregister lost the race", async () => {
    const session = await openSession(DRIVER_USER);
    const token = await registerDevice(session);

    const logout = await call("POST", "/user/logout", session);

    expect(logout.statusCode).toBe(200);

    // The app's DELETE, arriving after the revoke, is refused as before…
    const late = await call("DELETE", "/notification/push-token", session, {
      token,
    });

    expect(late.statusCode).toBe(401);

    // …and no longer matters: the logout took the device with it.
    expect(await devicesWith(token)).toBe(0);
  });

  it("leaves the user's other sessions' devices alone", async () => {
    const phone = await openSession(DRIVER_USER);
    const tablet = await openSession(DRIVER_USER);

    await registerDevice(phone);
    const tabletToken = await registerDevice(tablet);

    expect((await call("POST", "/user/logout", phone)).statusCode).toBe(200);

    expect(await devicesWith(tabletToken)).toBe(1);
  });
});

describe("ending every session of the user", () => {
  it("unregisters every device when the sessions are invalidated", async () => {
    const { UserRepository } = await import(
      "@/modules/user/repositories/user-repository"
    );

    const token = await registerDevice(await openSession(DRIVER_USER));

    await new UserRepository(prisma).invalidateUserSessions(DRIVER_USER);

    expect(await devicesWith(token)).toBe(0);
  });

  it("unregisters every device when the password changes", async () => {
    const { UserRepository } = await import(
      "@/modules/user/repositories/user-repository"
    );

    const token = await registerDevice(await openSession(DRIVER_USER));

    await new UserRepository(prisma).updateUserPassword({
      userId: DRIVER_USER,
      password: "outro-hash",
    });

    expect(await devicesWith(token)).toBe(0);
  });

  it("unregisters every device when access is revoked", async () => {
    const { UserRepository } = await import(
      "@/modules/user/repositories/user-repository"
    );

    const token = await registerDevice(await openSession(DRIVER_USER));

    const repository = new UserRepository(prisma);

    try {
      expect(
        await repository.toggleUserAccessRevocation(DRIVER_USER, false),
      ).toBe(true);

      expect(await devicesWith(token)).toBe(0);
    } finally {
      await repository.toggleUserAccessRevocation(DRIVER_USER, true);
    }
  });
});

describe("a session that ended without telling the server", () => {
  it("loses its device once the family has expired and been purged", async () => {
    const { cleanupExpiredRefreshTokensJob } = await import(
      "@/jobs/cron/cleanup-expired-refresh-tokens-job"
    );

    // An offline logout: the phone forgot the session, the server never heard.
    const session = await openSession(DRIVER_USER);
    const token = await registerDevice(session);

    const live = await openSession(DRIVER_USER);
    const liveToken = await registerDevice(live);

    await prisma.refreshToken.updateMany({
      where: { family_id: session.familyId },
      data: { expires_in: new Date(Date.now() - 1000) },
    });

    await cleanupExpiredRefreshTokensJob.handler();

    expect(await devicesWith(token)).toBe(0);

    // A device whose session is alive stays.
    expect(await devicesWith(liveToken)).toBe(1);
  });
});
