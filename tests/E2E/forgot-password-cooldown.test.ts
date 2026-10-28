import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import { randomInt, randomUUID } from "node:crypto";

/**
 * "Esqueci minha senha" flooded from many addresses at one inbox, through the
 * whole stack: the route limiter, the use case and the real Redis.
 *
 * The route's limit is per caller address, so each request below comes from
 * a different one — the attack the per-recipient cooldown exists for. Every
 * caller must get the same 200 and the same sentence, and only the first may
 * produce an e-mail and a link (shared/security/mail-cooldown.ts). Redis must
 * hold a hash, never the address.
 */
const mailed: string[] = [];

vi.mock("@/shared/services/transactional-mail-service", () => ({
  sendTransactionalMail: async ({ email }: { email: string }) => {
    mailed.push(email);
  },
}));

const prisma = new PrismaClient();
const redis = new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379", {
  lazyConnect: true,
  maxRetriesPerRequest: 1,
});

let app: Awaited<typeof import("@/http")>["app"];
let mailCooldownKey: typeof import("@/shared/security/mail-cooldown").mailCooldownKey;

const BUSINESS = randomUUID();
const EMAIL = `caixa-${randomUUID()}@exemplo.com.br`;

const octet = () => randomInt(1, 250);

beforeAll(async () => {
  await redis.connect();

  await prisma.business.create({
    data: {
      id: BUSINESS,
      corporate_reason: "Transportadora da Caixa Cheia",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(71000000000000 + randomInt(1, 9_000_000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `caixa-empresa-${randomUUID()}@exemplo.com.br`,
    },
  });

  await prisma.user.create({
    data: {
      name: "Pessoa Visada",
      email: EMAIL,
      password: "nao-usado",
      role: "BUSINESS_ADMIN",
      businessId: BUSINESS,
      email_verified: new Date(),
    },
  });

  ({ mailCooldownKey } = await import("@/shared/security/mail-cooldown"));
  ({ app } = await import("@/http"));
  await app.ready();

  // The rate-limit connection (which the cooldown shares) fails open until it
  // is ready, and a loop of `inject` never yields to the I/O that readies it.
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const answer = await app.inject({
      method: "GET",
      url: "/health/liveness",
      remoteAddress: `10.${octet()}.${octet()}.${octet()}`,
    });

    if (answer.headers["x-ratelimit-reset"] !== "0") break;

    await new Promise((done) => setTimeout(done, 100));
  }
}, 120_000);

afterAll(async () => {
  await redis.del(mailCooldownKey("forgot-password", EMAIL)).catch(() => 0);
  await prisma.forgotPasswordVerificationToken.deleteMany({
    where: { email: EMAIL },
  });
  await prisma.user.deleteMany({ where: { businessId: BUSINESS } });
  await prisma.business.deleteMany({ where: { id: BUSINESS } });

  await app?.close();
  redis.disconnect();
  await prisma.$disconnect();
}, 60_000);

describe("a reset flood aimed at one inbox from many addresses", () => {
  it("answers every caller the same and mails one link", async () => {
    const answers = [];

    for (let index = 0; index < 6; index += 1) {
      answers.push(
        await app.inject({
          method: "POST",
          url: "/user/forgot/password",
          // A new caller every time: the route limit never trips.
          remoteAddress: `189.${octet()}.${octet()}.${octet()}`,
          payload: { email: index % 2 === 0 ? EMAIL : EMAIL.toUpperCase() },
        }),
      );
    }

    const first = answers[0];

    expect(first.statusCode, first.body).toBe(200);

    for (const answer of answers) {
      expect(answer.statusCode).toBe(first.statusCode);
      expect(answer.body).toBe(first.body);
    }

    // Let the after-the-answer send land.
    await new Promise((resolve) => setImmediate(resolve));

    expect(mailed).toEqual([EMAIL]);
    expect(
      await prisma.forgotPasswordVerificationToken.count({
        where: { email: EMAIL },
      }),
    ).toBe(1);
  });

  it("keeps a window of at most 60 s in Redis under a hash, never the address", async () => {
    const ttl = await redis.ttl(mailCooldownKey("forgot-password", EMAIL));

    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);

    const keys = await redis.keys("mail-cooldown:*");
    const local = EMAIL.split("@")[0];

    expect(keys.length).toBeGreaterThan(0);
    expect(keys.some((key) => key.includes(local))).toBe(false);
  });
});
