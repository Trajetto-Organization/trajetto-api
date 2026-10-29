import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import { hash } from "bcrypt";
import { decode } from "jsonwebtoken";

import { issueSessionTokenPair } from "@/modules/user/services/session-service";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * The refresh policy per client, over HTTP and against Postgres (AUTH-07).
 *
 * The unit file drives the clock; this one proves the wiring the unit file
 * cannot see — the header read by the login route, the row the Prisma
 * repository writes, and the rotation's SQL at the edge of expiry.
 */
const prisma = createPrismaClient();

const CARRIER = "018fb000-0000-7000-8000-00000000c0a1";
const USER = "018fb000-0000-7000-8000-00000000c0b1";

const EMAIL = `politica-${randomUUID()}@exemplo.com.br`;
const PASSWORD = "senha-certa-123";

const DAY_SECONDS = 24 * 60 * 60;

let app: Awaited<typeof import("@/http")>["app"];

let next = 1;

/** A fresh address per request: this file is not about the route limits. */
const address = () => `10.78.${Math.floor(next / 250)}.${(next++ % 250) + 1}`;

const login = (headers: Record<string, string> = {}) =>
  app.inject({
    method: "POST",
    url: "/user/session",
    remoteAddress: address(),
    headers,
    payload: { email: EMAIL, password: PASSWORD },
  });

const refresh = (token: string) =>
  app.inject({
    method: "POST",
    url: "/user/refresh-token",
    remoteAddress: address(),
    payload: { token },
  });

interface RefreshClaims {
  exp: number;
  iat: number;
  jti: string;
  sessionClient?: string;
}

const claimsOf = (token: string) => decode(token) as RefreshClaims;

async function rowOf(token: string) {
  return prisma.refreshToken.findFirstOrThrow({
    where: { jti: claimsOf(token).jti },
  });
}

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora da Política",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: "55222888000258",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `politica-${randomUUID()}@exemplo.com.br`,
    },
  });

  await prisma.user.create({
    data: {
      id: USER,
      name: "Gestora da Política",
      email: EMAIL,
      password: await hash(PASSWORD, 4),
      role: "BUSINESS_ADMIN",
      businessId: CARRIER,
      email_verified: new Date(),
    },
  });

  ({ app } = await import("@/http"));
  await app.ready();
}, 90_000);

afterAll(async () => {
  await prisma.refreshToken.deleteMany({ where: { userId: USER } });
  await prisma.user.deleteMany({ where: { id: USER } });
  await prisma.business.deleteMany({ where: { id: CARRIER } });

  await app?.close();
  await prisma.$disconnect();
});

describe("a login from the app", () => {
  it("gets a refresh token that idles for seven days", async () => {
    const response = await login({ "x-trajetto-client": "mobile" });

    expect(response.statusCode).toBe(200);

    const { refresh_token } = response.json();
    const claims = claimsOf(refresh_token);

    expect(claims.exp - claims.iat).toBe(7 * DAY_SECONDS);
    expect(claims.sessionClient).toBe("mobile");

    // The row and the JWT lapse at the same instant.
    expect((await rowOf(refresh_token)).expires_in.getTime()).toBe(
      claims.exp * 1000,
    );
  });

  it("keeps the app's policy when it rotates", async () => {
    const { refresh_token } = (
      await login({ "x-trajetto-client": "mobile" })
    ).json();

    const rotated = await refresh(refresh_token);

    expect(rotated.statusCode).toBe(200);

    const claims = claimsOf(rotated.json().refresh_token);

    expect(claims.exp - claims.iat).toBe(7 * DAY_SECONDS);
  });
});

describe("a login without the header", () => {
  it("keeps the web's day, which is what every existing client gets", async () => {
    const response = await login();

    expect(response.statusCode).toBe(200);

    const claims = claimsOf(response.json().refresh_token);

    expect(claims.exp - claims.iat).toBe(DAY_SECONDS);
  });

  it("is not upgraded by an unknown header value", async () => {
    const claims = claimsOf(
      (await login({ "x-trajetto-client": "forever" })).json().refresh_token,
    );

    expect(claims.exp - claims.iat).toBe(DAY_SECONDS);
  });
});

describe("a refresh that passed verify just as its row lapsed", () => {
  it("ends that session and burns nothing else", async () => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: USER } });
    const pair = issueSessionTokenPair(user as never);

    // The JWT is still good; the row has just lapsed — the window between
    // `verify` and the rotation's UPDATE.
    await prisma.refreshToken.create({
      data: {
        userId: USER,
        token_hash: pair.refreshTokenHash,
        jti: pair.refreshJti,
        family_id: pair.familyId,
        expires_in: new Date(Date.now() - 1),
      },
    });

    const response = await refresh(pair.refresh_token);

    expect(response.statusCode).toBe(401);

    // Not AUTH_REFRESH_REUSED: that verdict logs the account out everywhere.
    expect(response.json().code).toBe("AUTH_SESSION_INVALIDATED");

    const after = await prisma.user.findUniqueOrThrow({ where: { id: USER } });

    expect(after.session_version).toBe(user.session_version);
  });

  it("is not a replay when a sibling spent it a moment earlier", async () => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: USER } });
    const pair = issueSessionTokenPair(user as never);

    // Two tabs racing at the very end of the token's life: the first rotated
    // it moments ago, and the row has lapsed since the second's `verify`.
    await prisma.refreshToken.create({
      data: {
        userId: USER,
        token_hash: pair.refreshTokenHash,
        jti: pair.refreshJti,
        family_id: pair.familyId,
        revoked_at: new Date(Date.now() - 50),
        replaced_by_jti: randomUUID(),
        expires_in: new Date(Date.now() - 1),
      },
    });

    const response = await refresh(pair.refresh_token);

    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe("AUTH_SESSION_INVALIDATED");

    const after = await prisma.user.findUniqueOrThrow({ where: { id: USER } });

    expect(after.session_version).toBe(user.session_version);
  });
});
