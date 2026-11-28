import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { randomInt, randomUUID } from "node:crypto";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * Each company's panel budget through the whole stack, on the real Redis
 * (plano-escala F2-28, decision D41).
 *
 * The budget is shrunk for the test (40 units a minute, a quarter of it per
 * person, so 10) and each GET /user/me costs 1. What must hold:
 *
 *  - one person alone is refused at their slice, BEFORE the session lookup
 *    (a revoked token in a loop costs the database nothing), and never
 *    spends more than a quarter of the company;
 *  - the company is refused once its people together spent the budget,
 *    after the lookup, and another company is untouched;
 *  - the MASTER never pays;
 *  - observe (the default) answers exactly as without a budget.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];
let env: (typeof import("@/env"))["env"];
let UserRepository: typeof import("@/modules/user/repositories/user-repository").UserRepository;
let panelBudgetMetrics: (typeof import("@/shared/integration/panel-budget"))["panelBudgetMetrics"];

const businesses: string[] = [];
const users: string[] = [];

const octet = () => randomInt(1, 250);

async function newBusiness(): Promise<string> {
  const id = randomUUID();

  await prisma.business.create({
    data: {
      id,
      corporate_reason: `Transportadora do Orçamento ${id.slice(0, 6)}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(72000000000000 + randomInt(1, 9_000_000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `orcamento-${randomUUID()}@example.com`,
    },
  });

  businesses.push(id);

  return id;
}

/** A signed-in person: their access token, with a live session. */
async function signedIn(
  role: "BUSINESS_ADMIN" | "BUSINESS_USER" | "MASTER",
  businessId: string | null,
): Promise<string> {
  const user = await prisma.user.create({
    data: {
      id: randomUUID(),
      name: "Pessoa do Painel",
      email: `pessoa-${randomUUID()}@example.com`,
      password: "nao-usado",
      role,
      businessId,
    },
  });

  users.push(user.id);

  const { issueSessionTokenPair } =
    await import("@/modules/user/services/session-service");

  const pair = issueSessionTokenPair(user as never);

  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      token_hash: pair.refreshTokenHash,
      jti: pair.refreshJti,
      family_id: pair.familyId,
      expires_in: pair.expiresAt,
    },
  });

  return pair.token;
}

const me = (token: string) =>
  app.inject({
    method: "GET",
    url: "/user/me",
    remoteAddress: `10.${octet()}.${octet()}.${octet()}`,
    headers: { authorization: `Bearer ${token}` },
  });

async function statuses(token: string, count: number): Promise<number[]> {
  const answers: number[] = [];

  for (let index = 0; index < count; index += 1) {
    answers.push((await me(token)).statusCode);
  }

  return answers;
}

let saved: { mode: string; perMinute: number; share: number };

beforeAll(async () => {
  ({ env } = await import("@/env"));
  ({ UserRepository } =
    await import("@/modules/user/repositories/user-repository"));
  ({ panelBudgetMetrics } = await import("@/shared/integration/panel-budget"));
  ({ app } = await import("@/http"));
  await app.ready();

  saved = {
    mode: env.TENANT_PANEL_BUDGET_MODE,
    perMinute: env.TENANT_PANEL_BUDGET_PER_MINUTE,
    share: env.TENANT_PANEL_USER_SHARE,
  };

  env.TENANT_PANEL_BUDGET_PER_MINUTE = 40;
  env.TENANT_PANEL_USER_SHARE = 0.25;

  // The budget fails open until its Redis connection is ready, and a loop of
  // `inject` never yields to the I/O that would make it ready.
  const probe = await signedIn("BUSINESS_ADMIN", await newBusiness());

  await vi.waitFor(
    async () => {
      const before = panelBudgetMetrics.snapshot().charged.user;

      await me(probe);

      expect(panelBudgetMetrics.snapshot().charged.user).toBeGreaterThan(
        before,
      );
    },
    { timeout: 10_000, interval: 100 },
  );
}, 120_000);

afterAll(async () => {
  if (env && saved) {
    env.TENANT_PANEL_BUDGET_MODE = saved.mode as never;
    env.TENANT_PANEL_BUDGET_PER_MINUTE = saved.perMinute;
    env.TENANT_PANEL_USER_SHARE = saved.share;
  }

  await prisma.refreshToken.deleteMany({ where: { userId: { in: users } } });
  await prisma.user.deleteMany({ where: { id: { in: users } } });
  await prisma.business.deleteMany({ where: { id: { in: businesses } } });

  await app?.close();
  await prisma.$disconnect();
}, 60_000);

describe("in observe (the default)", () => {
  it("answers exactly as without a budget, and counts what enforce would refuse", async () => {
    expect(env.TENANT_PANEL_BUDGET_MODE).toBe("observe");

    const token = await signedIn("BUSINESS_ADMIN", await newBusiness());
    const before = panelBudgetMetrics.snapshot().would_refuse.user;

    expect(new Set(await statuses(token, 14))).toEqual(new Set([200]));
    expect(panelBudgetMetrics.snapshot().would_refuse.user - before).toBe(4);
  });
});

describe("in enforce", () => {
  beforeAll(() => {
    env.TENANT_PANEL_BUDGET_MODE = "enforce";
  });

  afterAll(() => {
    env.TENANT_PANEL_BUDGET_MODE = "observe";
  });

  it("refuses one person at a quarter of the company, before the session lookup", async () => {
    const token = await signedIn("BUSINESS_ADMIN", await newBusiness());

    expect(new Set(await statuses(token, 10))).toEqual(new Set([200]));

    const lookups = vi.spyOn(UserRepository.prototype, "findUserById");
    const refused = await me(token);

    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toMatchObject({ code: "TENANT_BUSY" });
    expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);
    expect(Number(refused.headers["retry-after"])).toBeLessThanOrEqual(60);
    expect(lookups).not.toHaveBeenCalled();

    lookups.mockRestore();
  });

  it("refuses the company once its people spent the budget, and no other company", async () => {
    const business = await newBusiness();
    const people = await Promise.all(
      [0, 1, 2, 3, 4].map(() => signedIn("BUSINESS_ADMIN", business)),
    );

    // Four people, ten each: the company's forty.
    for (const token of people.slice(0, 4)) {
      expect(new Set(await statuses(token, 10))).toEqual(new Set([200]));
    }

    const fifth = await me(people[4]);

    expect(fifth.statusCode).toBe(429);
    expect(fifth.json()).toMatchObject({
      code: "TENANT_BUSY",
      message:
        "A sua empresa fez requisições demais neste minuto. Tente de novo em instantes.",
    });

    // Another company has its own minute.
    const other = await signedIn("BUSINESS_ADMIN", await newBusiness());

    expect((await me(other)).statusCode).toBe(200);
  });

  it("never charges the MASTER", async () => {
    const master = await signedIn("MASTER", null);

    expect(new Set(await statuses(master, 15))).toEqual(new Set([200]));
  });
});
