import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import {
  hashRefreshToken,
  issueSessionTokenPair,
} from "@/modules/user/services/session-service";

/**
 * Refresh-token rotation against the real database, where the race lives.
 *
 * Every rotation used to be single-shot, and the second presentation of a
 * token was read as theft: every session of the account was invalidated, on
 * every device, with a "session compromised" warning. Two requests of the same
 * session refreshing at once — two tabs, the web middleware handling parallel
 * prefetches, a phone retrying after its answer was lost — did exactly that.
 * The rotation was only ever tested against the in-memory repository, where
 * there is no concurrency to lose.
 *
 * Asserted on the database: `session_version` is what "log out everywhere"
 * bumps, so it is what tells a race handled from a race that burned the account.
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const BUSINESS = "018fc000-0000-7000-8000-0000000002b1";
const USER = "018fc000-0000-7000-8000-0000000002c1";

async function openSession(): Promise<{ refresh: string; familyId: string }> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: USER } });
  const pair = issueSessionTokenPair(user as never);

  await prisma.refreshToken.create({
    data: {
      userId: USER,
      token_hash: pair.refreshTokenHash,
      jti: pair.refreshJti,
      family_id: pair.familyId,
      expires_in: pair.expiresAt,
    },
  });

  return { refresh: pair.refresh_token, familyId: pair.familyId };
}

/**
 * Each call from its own address: this file is about rotation, and the
 * per-address refresh limit would otherwise start answering 429 halfway
 * through it.
 */
let caller = 0;

const refresh = (token: string) => {
  caller += 1;

  return app.inject({
    method: "POST",
    url: "/user/refresh-token",
    payload: { token },
    remoteAddress: `10.20.${Math.floor(caller / 250)}.${caller % 250}`,
  });
};

async function sessionVersion(): Promise<number> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: USER } });
  return user.session_version ?? 0;
}

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: BUSINESS,
      corporate_reason: "Transportadora Refresh",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: "44555666000101",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `refresh-${randomUUID()}@exemplo.com.br`,
    },
  });

  await prisma.user.create({
    data: {
      id: USER,
      name: "Pessoa Refresh",
      email: `refresh-user-${randomUUID()}@exemplo.com.br`,
      password: "nao-usado",
      role: "BUSINESS_ADMIN",
      businessId: BUSINESS,
    },
  });

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await prisma.refreshToken.deleteMany({ where: { userId: USER } });
  await prisma.user.deleteMany({ where: { id: USER } });
  await prisma.business.deleteMany({ where: { id: BUSINESS } });

  await app?.close();
  await prisma.$disconnect();
}, 60_000);

describe("refreshing the same token twice at once", () => {
  it("answers both and logs nobody out", async () => {
    const { refresh: token, familyId } = await openSession();
    const before = await sessionVersion();

    const [first, second] = await Promise.all([refresh(token), refresh(token)]);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);

    // Each tab walks away with a working token of its own…
    expect(first.json().refresh_token).not.toBe(second.json().refresh_token);

    // …and the account's other sessions were not touched.
    expect(await sessionVersion()).toBe(before);

    const live = await prisma.refreshToken.count({
      where: { family_id: familyId, revoked_at: null },
    });

    expect(live).toBe(2);
  });

  it("keeps each sibling usable afterwards", async () => {
    const { refresh: token } = await openSession();

    const [first, second] = await Promise.all([refresh(token), refresh(token)]);

    const next = await Promise.all([
      refresh(first.json().refresh_token),
      refresh(second.json().refresh_token),
    ]);

    expect(next.map((response) => response.statusCode)).toEqual([200, 200]);
  });
});

describe("a replay outside the grace window", () => {
  it("still invalidates every session of the account", async () => {
    const { refresh: token } = await openSession();

    expect((await refresh(token)).statusCode).toBe(200);

    // The copy is presented two minutes after the legitimate rotation.
    await prisma.refreshToken.update({
      where: { token_hash: hashRefreshToken(token) },
      data: { revoked_at: new Date(Date.now() - 2 * 60_000) },
    });

    const before = await sessionVersion();
    const replay = await refresh(token);

    expect(replay.statusCode).toBe(401);
    expect(await sessionVersion()).toBe(before + 1);
  });
});

/**
 * At most three siblings per spent token. The grace used to mint a live token
 * on every presentation inside the minute: a copy replayed right after the
 * legitimate rotation got a working session each time and reuse detection
 * never fired. A cap of one was too tight the other way: a page whose access
 * token expired renews from several parallel requests, and the third became
 * a logout on every device. The row counts its siblings (grace_siblings)
 * with a conditional UPDATE.
 */
describe("a presentation past the grace allowance", () => {
  it("survives the parallel renewals of one page", async () => {
    const { refresh: token } = await openSession();

    const statuses = (
      await Promise.all([
        refresh(token),
        refresh(token),
        refresh(token),
        refresh(token),
      ])
    ).map((response) => response.statusCode);

    expect(statuses).toEqual([200, 200, 200, 200]);
  });

  it("is reuse: refused, and every session of the account ends", async () => {
    const { refresh: token, familyId } = await openSession();

    for (let presentation = 0; presentation < 4; presentation += 1) {
      expect((await refresh(token)).statusCode).toBe(200);
    }

    const before = await sessionVersion();
    const fifth = await refresh(token);

    expect(fifth.statusCode).toBe(401);
    expect(fifth.json().code).toBe("AUTH_REFRESH_REUSED");
    expect(await sessionVersion()).toBe(before + 1);
    expect(
      await prisma.refreshToken.count({ where: { family_id: familyId } }),
    ).toBe(0);
  });

  it("grants the last sibling to only one of two late presentations racing on Postgres", async () => {
    const { refresh: token, familyId } = await openSession();

    for (let presentation = 0; presentation < 3; presentation += 1) {
      expect((await refresh(token)).statusCode).toBe(200);
    }

    const before = await sessionVersion();
    const statuses = (await Promise.all([refresh(token), refresh(token)])).map(
      (response) => response.statusCode,
    );

    expect(statuses.sort()).toEqual([200, 401]);
    expect(await sessionVersion()).toBe(before + 1);
    expect(
      await prisma.refreshToken.count({ where: { family_id: familyId } }),
    ).toBe(0);
  });

  it("counts the siblings on the spent row", async () => {
    const { refresh: token } = await openSession();

    const [first, second] = await Promise.all([refresh(token), refresh(token)]);

    expect([first.statusCode, second.statusCode]).toEqual([200, 200]);

    const spent = await prisma.refreshToken.findUniqueOrThrow({
      where: { token_hash: hashRefreshToken(token) },
    });

    expect(spent.revoked_at).not.toBeNull();
    expect(spent.grace_siblings).toBe(1);
  });
});

describe("a session that already ended", () => {
  it("is refused without logging out the other devices", async () => {
    const other = await openSession();
    const { refresh: token, familyId } = await openSession();

    // Logout deletes the family.
    await prisma.refreshToken.deleteMany({ where: { family_id: familyId } });

    const before = await sessionVersion();
    const stale = await refresh(token);

    expect(stale.statusCode).toBe(401);
    expect(await sessionVersion()).toBe(before);

    // The device that never logged out keeps working.
    expect((await refresh(other.refresh)).statusCode).toBe(200);
  });
});
