import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { hash } from "bcrypt";
import { createHmac, randomUUID } from "node:crypto";
import { decode, sign } from "jsonwebtoken";

import auth from "@/config/auth";
import { issueTwoFactorChallenge } from "@/modules/user/services/two-factor-challenge";

import { APP_BOOT_TIMEOUT_MS } from "../support/app-boot";

/**
 * Someone holding a token, or pieces of one, trying to make it say more.
 *
 * Every case goes through the real login, the real middleware and a real
 * route (GET /user/me), against Postgres: a forged or replayed credential
 * must answer 401 (or the documented 403 for a session the company ended),
 * never data. The per-case unit tests of ensure-authenticated prove each
 * branch; this file proves the wiring holds when the token is hostile.
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const BUSINESS = randomUUID();
const PASSWORD = "senha-forte-123";

let next = 1;
/** One address per call: the anonymous route limit never counts twice. */
const address = () => `10.91.${Math.floor(next / 250)}.${(next++ % 250) + 1}`;

async function seedUser(): Promise<{ id: string; email: string }> {
  const id = randomUUID();
  const email = `auth-${id}@exemplo.com.br`;

  await prisma.user.create({
    data: {
      id,
      name: "Gestora",
      email,
      password: await hash(PASSWORD, 4),
      role: "BUSINESS_ADMIN",
      businessId: BUSINESS,
      email_verified: new Date(),
    },
  });

  return { id, email };
}

async function login(email: string): Promise<{ token: string; refresh_token: string }> {
  const response = await app.inject({
    method: "POST",
    url: "/user/session",
    remoteAddress: address(),
    payload: { email, password: PASSWORD },
  });

  expect(response.statusCode, response.body).toBe(200);

  return response.json();
}

const me = (token: string) =>
  app.inject({
    method: "GET",
    url: "/user/me",
    remoteAddress: address(),
    headers: { authorization: `Bearer ${token}` },
  });

function base64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** Same claims, re-signed or unsigned the way an attacker would try. */
function forge(claims: object, header: object, key: string | null): string {
  const unsigned = `${base64url(header)}.${base64url(claims)}`;

  if (key === null) return `${unsigned}.`;

  return `${unsigned}.${createHmac("sha256", key).update(unsigned).digest("base64url")}`;
}

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: BUSINESS,
      corporate_reason: `Transportadora Auth ${BUSINESS}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(Date.now()).padStart(14, "7").slice(-14),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `auth-${BUSINESS}@exemplo.com.br`,
    },
  });

  ({ app } = await import("@/http"));
  await app.ready();
}, APP_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

describe("a forged access token", () => {
  it("is accepted only as issued", async () => {
    const user = await seedUser();
    const { token } = await login(user.email);

    expect((await me(token)).statusCode).toBe(200);
  });

  it("with alg none is refused", async () => {
    const user = await seedUser();
    const { token } = await login(user.email);
    const claims = decode(token) as object;

    const response = await me(forge(claims, { alg: "none", typ: "JWT" }, null));

    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe("AUTH_TOKEN_INVALID");
  });

  it("re-signed with the refresh key, or any other key, is refused", async () => {
    const user = await seedUser();
    const { token } = await login(user.email);
    const claims = decode(token) as object;

    for (const key of [auth.secret_refresh_token, "chave-adivinhada", ""]) {
      const response = await me(forge(claims, { alg: "HS256", typ: "JWT" }, key));
      expect(response.statusCode).toBe(401);
    }
  });

  it("with its subject swapped for another user's is refused", async () => {
    const victim = await seedUser();
    const attacker = await seedUser();
    const { token } = await login(attacker.email);

    const [header, , signature] = token.split(".");
    const claims = { ...(decode(token) as object), sub: victim.id };

    const response = await me(`${header}.${base64url(claims)}.${signature}`);

    expect(response.statusCode).toBe(401);
  });

  it("past its expiry is refused", async () => {
    const user = await seedUser();
    const { token } = await login(user.email);
    const { familyId } = decode(token) as { familyId: string };

    const expired = sign(
      { tokenType: "access", sessionVersion: 0, familyId, exp: Math.floor(Date.now() / 1000) - 10 },
      auth.secret_token,
      { subject: user.id },
    );

    const response = await me(expired);

    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe("AUTH_TOKEN_INVALID");
  });

  it("of another kind is refused: the refresh token and the 2FA challenge", async () => {
    const user = await seedUser();
    const { refresh_token } = await login(user.email);

    expect((await me(refresh_token)).statusCode).toBe(401);

    const challenge = issueTwoFactorChallenge({ id: user.id, email: user.email, session_version: 0 });
    expect((await me(challenge)).statusCode).toBe(401);
  });

  it("signed with the right key but missing the session claims is refused", async () => {
    const user = await seedUser();

    for (const claims of [
      { tokenType: "access", sessionVersion: 0 },
      { tokenType: "access", familyId: randomUUID() },
      { sessionVersion: 0, familyId: randomUUID() },
    ]) {
      const response = await me(sign(claims, auth.secret_token, { subject: user.id, expiresIn: "5m" }));
      expect(response.statusCode, JSON.stringify(claims)).toBe(401);
    }
  });

  it("for a session family that never existed is refused", async () => {
    const user = await seedUser();

    const invented = sign(
      { tokenType: "access", sessionVersion: 0, familyId: randomUUID() },
      auth.secret_token,
      { subject: user.id, expiresIn: "5m" },
    );

    const response = await me(invented);

    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe("AUTH_SESSION_INVALIDATED");
  });
});

describe("a session that ended", () => {
  it("by logout refuses both its access and its refresh token", async () => {
    const user = await seedUser();
    const session = await login(user.email);
    const other = await login(user.email);

    const logout = await app.inject({
      method: "POST",
      url: "/user/logout",
      remoteAddress: address(),
      headers: { authorization: `Bearer ${session.token}` },
    });
    expect(logout.statusCode, logout.body).toBeLessThan(300);

    expect((await me(session.token)).statusCode).toBe(401);

    const refresh = await app.inject({
      method: "POST",
      url: "/user/refresh-token",
      remoteAddress: address(),
      payload: { token: session.refresh_token },
    });
    expect(refresh.statusCode).toBe(401);

    // Only that device: the other session stays.
    expect((await me(other.token)).statusCode).toBe(200);
  });

  it("by a session_version bump (role change, reset) refuses the old token", async () => {
    const user = await seedUser();
    const { token } = await login(user.email);

    await prisma.user.update({ where: { id: user.id }, data: { session_version: { increment: 1 } } });

    const response = await me(token);

    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe("AUTH_SESSION_INVALIDATED");
  });

  it("by a revoked access answers 403 on the very next request", async () => {
    const user = await seedUser();
    const { token } = await login(user.email);

    await prisma.user.update({ where: { id: user.id }, data: { access_revoked: true } });

    const response = await me(token);

    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("AUTH_ACCESS_REVOKED");
  });

  it("by a deleted user is refused", async () => {
    const user = await seedUser();
    const { token } = await login(user.email);

    await prisma.refreshToken.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });

    expect((await me(token)).statusCode).toBe(401);
  });

  it("by its company being deactivated answers 403 mid-session", async () => {
    const other = randomUUID();

    await prisma.business.create({
      data: {
        id: other,
        corporate_reason: `Transportadora Desativada ${other}`,
        cep: "01001000",
        city: "São Paulo",
        uf: "SP",
        street: "Rua",
        address_number: "1",
        cnpj: String(Date.now() + 1).padStart(14, "6").slice(-14),
        cnae: "4930202",
        responsible_name: "Responsável",
        telephone: "11999999999",
        email: `auth-${other}@exemplo.com.br`,
      },
    });

    const id = randomUUID();
    const email = `auth-${id}@exemplo.com.br`;

    await prisma.user.create({
      data: {
        id,
        name: "Gestora",
        email,
        password: await hash(PASSWORD, 4),
        role: "BUSINESS_ADMIN",
        businessId: other,
        email_verified: new Date(),
      },
    });

    const { token } = await login(email);
    expect((await me(token)).statusCode).toBe(200);

    await prisma.business.update({ where: { id: other }, data: { is_active: false } });

    const response = await me(token);

    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("AUTH_BUSINESS_INACTIVE");
  });
});

describe("refresh token rotation", () => {
  it("issues a new pair, and a replay of the old one outside the grace window ends every session", async () => {
    const user = await seedUser();
    const first = await login(user.email);

    const rotate = (token: string) =>
      app.inject({
        method: "POST",
        url: "/user/refresh-token",
        remoteAddress: address(),
        payload: { token },
      });

    const rotated = await rotate(first.refresh_token);
    expect(rotated.statusCode, rotated.body).toBe(200);

    const second = rotated.json() as { token: string; refresh_token: string };
    expect(second.refresh_token).not.toBe(first.refresh_token);

    // Push the rotation out of the race grace window, as a thief replaying a
    // copied token minutes later would be.
    await prisma.refreshToken.updateMany({
      where: { userId: user.id, revoked_at: { not: null } },
      data: { revoked_at: new Date(Date.now() - 10 * 60 * 1000) },
    });

    const replay = await rotate(first.refresh_token);
    expect(replay.statusCode).toBe(401);

    // Reuse detection: the legitimate holder of the newer pair is out too.
    expect((await me(second.token)).statusCode).toBe(401);
  });
});
