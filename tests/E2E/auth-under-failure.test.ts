import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { sign } from "jsonwebtoken";
import auth from "@/config/auth";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * What the API answers when it cannot reach its own database.
 *
 * Found by failure injection, not by reading: with Postgres stopped, every
 * authenticated route answered 401 after 4,3 seconds. Both clients read a 401
 * as "your session ended" and log the user out — the mobile one calls
 * `handleUnauthorized()` straight into the logout callback. Thirty seconds of
 * a database blip would have logged out every driver in the field, mid-route,
 * with no way back in until signal and credentials lined up.
 *
 * The cause was one `try` around the whole middleware: the token check and the
 * database lookups shared a catch that turned everything into
 * AUTH_TOKEN_INVALID. A database that is down is not an invalid token.
 *
 * Simulated here by pointing the repository at a client that cannot connect,
 * rather than by stopping the container: a test that stopped Postgres would
 * take the rest of the suite with it.
 */
const prisma = createPrismaClient();

const CARRIER = "018fb000-0000-7000-8000-00000000000a";
const USER = "018fb000-0000-7000-8000-0000000000a1";

let app: Awaited<typeof import("@/http")>["app"];

let token: string;

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora da Falha",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: "55222888000101",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `falha-${randomUUID()}@exemplo.com.br`,
    },
  });

  const familyId = randomUUID();

  await prisma.user.create({
    data: {
      id: USER,
      name: "Gestora",
      email: `gestora-${randomUUID()}@exemplo.com.br`,
      password: "nao-usado",
      role: "BUSINESS_ADMIN",
      businessId: CARRIER,
    },
  });

  await prisma.refreshToken.create({
    data: {
      userId: USER,
      token_hash: randomUUID(),
      jti: randomUUID(),
      family_id: familyId,
      expires_in: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

  token = sign(
    { tokenType: "access", sessionVersion: 0, familyId },
    auth.secret_token,
    { subject: USER, expiresIn: "1h" },
  );

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

const call = (headers: Record<string, string> = {}) =>
  app.inject({ method: "GET", url: "/notification/unread-count", headers });

describe("a token the caller got wrong", () => {
  it("is 401, because it is", async () => {
    const response = await call({ authorization: "Bearer nao-e-um-jwt" });

    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe("AUTH_TOKEN_INVALID");
  });

  it("is 401 when it was signed with somebody else's secret", async () => {
    const forged = sign(
      { tokenType: "access", sessionVersion: 0, familyId: randomUUID() },
      "segredo-de-outra-pessoa",
      { subject: USER, expiresIn: "1h" },
    );

    const response = await call({ authorization: `Bearer ${forged}` });

    expect(response.statusCode).toBe(401);
  });

  it("is 401 when it is a refresh token used as an access token", async () => {
    const wrongKind = sign(
      { tokenType: "refresh", sessionVersion: 0, familyId: randomUUID() },
      auth.secret_token,
      { subject: USER, expiresIn: "1h" },
    );

    const response = await call({ authorization: `Bearer ${wrongKind}` });

    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe("AUTH_TOKEN_INVALID");
  });

  it("is 401 when there is no token at all", async () => {
    expect((await call()).statusCode).toBe(401);
  });

  it("is 401 when the session was invalidated", async () => {
    const staleVersion = sign(
      { tokenType: "access", sessionVersion: 99, familyId: randomUUID() },
      auth.secret_token,
      { subject: USER, expiresIn: "1h" },
    );

    const response = await call({ authorization: `Bearer ${staleVersion}` });

    // A real session decision, made from data that was read successfully.
    expect(response.statusCode).toBe(401);
  });
});

describe("a database the API cannot reach", () => {
  it("is 503, never 401", async () => {
    const { UserRepository } = await import(
      "@/modules/user/repositories/user-repository"
    );

    const original = UserRepository.prototype.findUserById;

    // What Prisma raises when it cannot get a connection. The real class and
    // code: a plain Error is now (rightly) a bug, answered 500.
    UserRepository.prototype.findUserById = async () => {
      throw new Prisma.PrismaClientKnownRequestError(
        "Can't reach database server at localhost:5432",
        { code: "P1001", clientVersion: Prisma.prismaVersion.client },
      );
    };

    try {
      const response = await call({ authorization: `Bearer ${token}` });

      // The assertion this whole file exists for. A 401 here is every driver
      // in the field being logged out because a database restarted.
      expect(response.statusCode).toBe(503);
      expect(response.json().code).toBe("AUTH_SESSION_UNAVAILABLE");
      expect(response.headers["retry-after"]).toBe("5");
    } finally {
      UserRepository.prototype.findUserById = original;
    }
  });

  it("answers 200 again once the stub is gone", async () => {
    // This only proves the stub above was undone. Recovery from connections
    // Postgres really dropped is proved in database-reconnect.test.ts.
    const response = await call({ authorization: `Bearer ${token}` });

    expect(response.statusCode).toBe(200);
  });

  it("is 503 when the session store is the part that is unreachable", async () => {
    const { UserTokensRepository } = await import(
      "@/modules/user/repositories/user-tokens-repository"
    );

    const original = UserTokensRepository.prototype.hasActiveRefreshTokenFamily;

    UserTokensRepository.prototype.hasActiveRefreshTokenFamily = async () => {
      throw new Prisma.PrismaClientKnownRequestError(
        "Server has closed the connection.",
        { code: "P1017", clientVersion: Prisma.prismaVersion.client },
      );
    };

    try {
      const response = await call({ authorization: `Bearer ${token}` });

      // The second lookup, and the same rule: unreachable is not invalid.
      expect(response.statusCode).toBe(503);
    } finally {
      UserTokensRepository.prototype.hasActiveRefreshTokenFamily = original;
    }
  });
});

describe("a bug in the session check", () => {
  /**
   * Not every exception in the middleware is the database (GAP6-10).
   *
   * The catch used to turn ANY non-AppError into 503 AUTH_SESSION_UNAVAILABLE.
   * A regression in the eligibility or tenant check that threw a TypeError
   * for one profile then answered "come back later" to every request of that
   * user, forever: the app keeps a 5xx in its outbox and retries, the log
   * had only a console.error without the request id, and nothing alerted.
   */
  it("is a 500 with the stack in the log, not a transient 503", async () => {
    const { UserRepository } = await import(
      "@/modules/user/repositories/user-repository"
    );

    const original = UserRepository.prototype.findUserById;

    UserRepository.prototype.findUserById = async () => {
      throw new TypeError(
        "Cannot read properties of undefined (reading 'role')",
      );
    };

    try {
      const response = await call({ authorization: `Bearer ${token}` });

      expect(response.statusCode).toBe(500);
      expect(response.json().code).toBe("INTERNAL_ERROR");
      expect(response.headers["retry-after"]).toBeUndefined();
    } finally {
      UserRepository.prototype.findUserById = original;
    }
  });
});
