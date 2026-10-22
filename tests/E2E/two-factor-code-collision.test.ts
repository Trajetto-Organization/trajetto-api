import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { PrismaClient } from "@prisma/client";
import crypto, { randomUUID } from "node:crypto";

import { hash } from "bcrypt";

/**
 * Two accounts that draw the same six-digit code, against the real database.
 *
 * `two_factor_token.token` is UNIQUE (it has been since the table was made).
 * With bcrypt every stored value carried its own random salt, so two people
 * holding the same code never stored the same string. A keyed HMAC of the
 * code alone is deterministic: the second account to draw a code already held
 * by any row (rows live until spent, one per account with two-factor on) hit
 * the unique index, and its login answered 500. With 900 000 possible codes,
 * that is one login in every 900 000 / (rows) — about 1% of two-factor logins
 * once ten thousand accounts have a row.
 *
 * The code is forced to collide here instead of waiting for the birthday.
 */
vi.mock("@/shared/services/transactional-mail-service", () => ({
  sendTransactionalMail: vi.fn(async () => undefined),
}));

const prisma = new PrismaClient();

const CARRIER = randomUUID();
const FIRST = randomUUID();
const SECOND = randomUUID();

const FIRST_EMAIL = `colisao-a-${randomUUID()}@exemplo.com.br`;
const SECOND_EMAIL = `colisao-b-${randomUUID()}@exemplo.com.br`;

const PASSWORD = "senha-certa-123";
const SAME_CODE = 424_242;

let app: Awaited<typeof import("@/http")>["app"];

let next = 1;

/** A fresh address per request: the route limits never count two. */
const address = () => `10.78.${Math.floor(next / 250)}.${(next++ % 250) + 1}`;

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora da Coincidência",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(71000000000000 + crypto.randomInt(1, 9_000_000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `coincidencia-${randomUUID()}@exemplo.com.br`,
    },
  });

  const password = await hash(PASSWORD, 4);

  await prisma.user.createMany({
    data: [FIRST, SECOND].map((id, index) => ({
      id,
      name: `Gestora ${index + 1}`,
      email: index === 0 ? FIRST_EMAIL : SECOND_EMAIL,
      password,
      role: "BUSINESS_ADMIN" as const,
      businessId: CARRIER,
      email_verified: new Date(),
      two_factor_enabled: true,
    })),
  });

  ({ app } = await import("@/http"));
  await app.ready();
}, 90_000);

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.twoFactorToken.deleteMany({
    where: { email: { in: [FIRST_EMAIL, SECOND_EMAIL] } },
  });
  await prisma.twoFactorConfirmation.deleteMany({
    where: { userId: { in: [FIRST, SECOND] } },
  });
  await prisma.refreshToken.deleteMany({
    where: { userId: { in: [FIRST, SECOND] } },
  });
  await prisma.user.deleteMany({ where: { id: { in: [FIRST, SECOND] } } });
  await prisma.business.deleteMany({ where: { id: CARRIER } });

  await app?.close();
  await prisma.$disconnect();
});

const login = (email: string) =>
  app.inject({
    method: "POST",
    url: "/user/session",
    remoteAddress: address(),
    payload: { email, password: PASSWORD },
  });

describe("two accounts holding the same code at once", () => {
  it("both get their code, and each code opens its own session", async () => {
    vi.spyOn(crypto, "randomInt").mockReturnValue(SAME_CODE as never);

    const first = await login(FIRST_EMAIL);
    const second = await login(SECOND_EMAIL);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ twoFactorVerification: true });

    const verified = await app.inject({
      method: "POST",
      url: "/user/two-factor-verification",
      remoteAddress: address(),
      payload: {
        email: SECOND_EMAIL,
        code: String(SAME_CODE),
        challenge: second.json().twoFactorChallenge,
      },
    });

    expect(verified.statusCode).toBe(200);
    expect(verified.json().token).toEqual(expect.any(String));
  });
});
