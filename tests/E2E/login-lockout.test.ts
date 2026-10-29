import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import { hash } from "bcrypt";

import {
  LOGIN_LOCK_MS,
  MAX_FAILED_LOGINS,
} from "@/shared/security/login-lockout-rules";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * The login's brake on password guessing, against the real database.
 *
 * The route limit (eight a minute per address) lives in Redis and fails open
 * by design, and it is keyed by ADDRESS: with Redis down, or with the guesses
 * spread over many addresses, nothing bounded them. Every request here comes
 * from an address of its own, so the route limit never sees two of them —
 * exactly the case only a per-account count can stop.
 *
 * What this guards that the unit test cannot: the raw SQL — the atomic
 * increment under concurrency, the lock stamp, the conditional clear — and
 * that a failed login is not reported as an edit of the user.
 */
const prisma = createPrismaClient();

const CARRIER = "018fb000-0000-7000-8000-00000000b09a";
const USER = "018fb000-0000-7000-8000-00000000b0a1";
const OTHER = "018fb000-0000-7000-8000-00000000b0a2";

const EMAIL = `bloqueio-${randomUUID()}@exemplo.com.br`;
const OTHER_EMAIL = `concorrencia-${randomUUID()}@exemplo.com.br`;

const PASSWORD = "senha-certa-123";

let app: Awaited<typeof import("@/http")>["app"];

let next = 1;

/** A fresh address per request: the route limit never counts two. */
const address = () => `10.77.${Math.floor(next / 250)}.${(next++ % 250) + 1}`;

const login = (email: string, password: string) =>
  app.inject({
    method: "POST",
    url: "/user/session",
    remoteAddress: address(),
    payload: { email, password },
  });

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora do Bloqueio",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: "55222888000177",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `bloqueio-${randomUUID()}@exemplo.com.br`,
    },
  });

  const password = await hash(PASSWORD, 4);

  await prisma.user.createMany({
    data: [
      {
        id: USER,
        name: "Gestora",
        email: EMAIL,
        password,
        role: "BUSINESS_ADMIN",
        businessId: CARRIER,
        email_verified: new Date(),
      },
      {
        id: OTHER,
        name: "Outra Gestora",
        email: OTHER_EMAIL,
        password,
        role: "BUSINESS_ADMIN",
        businessId: CARRIER,
        email_verified: new Date(),
      },
    ],
  });

  ({ app } = await import("@/http"));
  await app.ready();
}, 90_000);

afterAll(async () => {
  await prisma.refreshToken.deleteMany({
    where: { userId: { in: [USER, OTHER] } },
  });
  await prisma.user.deleteMany({ where: { id: { in: [USER, OTHER] } } });
  await prisma.business.deleteMany({ where: { id: CARRIER } });

  await app?.close();
  await prisma.$disconnect();
});

describe("guessing a password from many addresses", () => {
  it("locks the account after the ceiling, even for the right password", async () => {
    const before = await prisma.user.findUniqueOrThrow({ where: { id: USER } });

    for (let attempt = 0; attempt < MAX_FAILED_LOGINS; attempt += 1) {
      const response = await login(EMAIL, "senha-errada");

      expect(response.statusCode, `guess ${attempt + 1}`).toBe(401);
    }

    const startedAt = Date.now();
    const refused = await login(EMAIL, PASSWORD);

    // The same answer as a wrong password: nothing tells the guesser that
    // this address has an account, or that they hit a lock.
    expect(refused.statusCode).toBe(401);
    expect(refused.json().code).toBe("AUTH_INVALID_CREDENTIALS");

    const row = await prisma.user.findUniqueOrThrow({ where: { id: USER } });

    expect(row.failed_login_attempts).toBe(MAX_FAILED_LOGINS);
    expect(row.login_locked_until).not.toBeNull();

    const lockLeft = row.login_locked_until!.getTime() - startedAt;

    expect(lockLeft).toBeGreaterThan(LOGIN_LOCK_MS - 60_000);
    expect(lockLeft).toBeLessThanOrEqual(LOGIN_LOCK_MS);

    // Counting guesses is not an edit of the user.
    expect(row.updated_at.getTime()).toBe(before.updated_at.getTime());
  });

  it("lets the owner in once the lock is over, and clears the count", async () => {
    await prisma.user.update({
      where: { id: USER },
      data: { login_locked_until: new Date(Date.now() - 1_000) },
    });

    const response = await login(EMAIL, PASSWORD);

    expect(response.statusCode).toBe(200);
    expect(response.json().token).toEqual(expect.any(String));
    // The sentence the web shows; it went out as "atutenticado".
    expect(response.json().message).toBe("Usuário autenticado com sucesso!");

    const row = await prisma.user.findUniqueOrThrow({ where: { id: USER } });

    expect(row).toMatchObject({
      failed_login_attempts: 0,
      failed_login_at: null,
      login_locked_until: null,
    });
  });

  it("counts every one of a burst of concurrent guesses", async () => {
    const burst = MAX_FAILED_LOGINS + 5;

    const responses = await Promise.all(
      Array.from({ length: burst }, () => login(OTHER_EMAIL, "senha-errada")),
    );

    expect(responses.every((response) => response.statusCode === 401)).toBe(
      true,
    );

    const row = await prisma.user.findUniqueOrThrow({ where: { id: OTHER } });

    // Each guess that got to the comparison before the lock landed is
    // counted; none is lost to a read-modify-write race.
    expect(row.failed_login_attempts).toBeGreaterThanOrEqual(MAX_FAILED_LOGINS);
    expect(row.login_locked_until!.getTime()).toBeGreaterThan(Date.now());

    expect((await login(OTHER_EMAIL, PASSWORD)).statusCode).toBe(401);
  });
});
