import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { sign } from "jsonwebtoken";
import auth from "@/config/auth";

import { generateApiKey } from "@/shared/integration/api-key-rules";

/**
 * Who sets the ceilings of the public API.
 *
 * The per-key rate limit was chosen by the tenant's own administrator, from
 * 10 to 6,000 a minute, with no cap on how many keys a company could hold and
 * no limit across them: twenty keys at 6,000 were 120,000 calls a minute from
 * one company, and the protection sat in the hands of whoever it was meant to
 * contain. Now the platform sets the ceiling: a company administrator
 * provisions up to the tenant ceiling per key, a MASTER above it; a company
 * holds a bounded number of active keys; and all of a company's keys share
 * one budget a minute.
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018fdc50-0000-7000-8000-00000000000a";
const ADMIN = "018fdc50-0000-7000-8000-0000000000a1";
const MASTER = "018fdc50-0000-7000-8000-0000000000a2";

let adminToken = "";
let masterToken = "";

async function tokenFor(
  userId: string,
  role: "BUSINESS_ADMIN" | "MASTER",
  businessId: string | null,
): Promise<string> {
  const familyId = randomUUID();

  await prisma.refreshToken.create({
    data: {
      userId,
      token_hash: randomUUID(),
      jti: randomUUID(),
      family_id: familyId,
      expires_in: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

  return sign(
    {
      tokenType: "access",
      role,
      businessId,
      driverId: null,
      sessionVersion: 0,
      familyId,
    },
    auth.secret_token,
    { subject: userId, expiresIn: "1h" },
  );
}

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora das Cotas",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(57000000000000 + Math.floor(Math.random() * 9000000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `cotas-${randomUUID()}@exemplo.com.br`,
    },
  });

  await prisma.businessEntitlement.create({
    data: { businessId: CARRIER, module: "DELIVERIES", enabled: true },
  });

  await prisma.user.create({
    data: {
      id: ADMIN,
      name: "Administradora das Cotas",
      email: `admin-${randomUUID()}@exemplo.com.br`,
      password: "nao-usado",
      role: "BUSINESS_ADMIN",
      businessId: CARRIER,
    },
  });

  await prisma.user.create({
    data: {
      id: MASTER,
      name: "Suporte da Plataforma",
      email: `master-${randomUUID()}@exemplo.com.br`,
      password: "nao-usado",
      role: "MASTER",
    },
  });

  adminToken = await tokenFor(ADMIN, "BUSINESS_ADMIN", CARRIER);
  masterToken = await tokenFor(MASTER, "MASTER", null);

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  const {
    configureIntegrationRateGuard,
    unlimitedIntegrationRateGuard,
  } = await import("@/shared/integration/integration-rate-guard");

  configureIntegrationRateGuard(unlimitedIntegrationRateGuard);

  await prisma.apiKeyUsageDaily.deleteMany({ where: { businessId: CARRIER } });
  await prisma.apiKey.deleteMany({ where: { businessId: CARRIER } });
  await prisma.refreshToken.deleteMany({
    where: { userId: { in: [ADMIN, MASTER] } },
  });
  await prisma.user.deleteMany({ where: { id: { in: [ADMIN, MASTER] } } });
  await prisma.businessEntitlement.deleteMany({ where: { businessId: CARRIER } });
  await prisma.business.deleteMany({ where: { id: CARRIER } });

  await app?.close();
  await prisma.$disconnect();
});

function issue(token: string, rate: number, name = "ERP") {
  return app.inject({
    method: "POST",
    url: `/integrations/api-key/${CARRIER}`,
    headers: { authorization: `Bearer ${token}` },
    payload: {
      name,
      scopes: ["deliveries:read"],
      rate_limit_per_minute: rate,
    },
  });
}

describe("the per-key ceiling", () => {
  it("is the platform's to raise, not the tenant's", async () => {
    const response = await issue(adminToken, 6000);

    expect(response.statusCode, response.body).toBe(403);
    expect(JSON.parse(response.body).code).toBe("API_KEY_RATE_ABOVE_PLAN");
  });

  it("lets a company administrator provision up to the tenant ceiling", async () => {
    const response = await issue(adminToken, 600);

    expect(response.statusCode, response.body).toBe(201);
  });

  it("lets a MASTER provision above it", async () => {
    const response = await issue(masterToken, 6000);

    expect(response.statusCode, response.body).toBe(201);
  });
});

describe("the number of active keys", () => {
  it("is bounded per company, and a revoked key frees its place", async () => {
    await prisma.apiKey.deleteMany({ where: { businessId: CARRIER } });

    for (let n = 0; n < 10; n += 1) {
      const key = generateApiKey();

      await prisma.apiKey.create({
        data: {
          name: `Chave ${n}`,
          prefix: key.prefix,
          token_hash: key.tokenHash,
          scopes: ["deliveries:read"],
          businessId: CARRIER,
        },
      });
    }

    const eleventh = await issue(adminToken, 120, "A décima primeira");

    expect(eleventh.statusCode, eleventh.body).toBe(409);
    expect(JSON.parse(eleventh.body).code).toBe("API_KEY_LIMIT_REACHED");

    // Not even the platform: the cap is on what a company holds.
    expect((await issue(masterToken, 120, "Pelo suporte")).statusCode).toBe(409);

    const one = await prisma.apiKey.findFirstOrThrow({
      where: { businessId: CARRIER, revoked_at: null },
    });

    await prisma.apiKey.update({
      where: { id: one.id },
      data: { revoked_at: new Date() },
    });

    expect((await issue(adminToken, 120, "No lugar da revogada")).statusCode).toBe(
      201,
    );
  });
});

describe("the company's budget across its keys", () => {
  it("refuses a valid key once the company spent its minute", async () => {
    await prisma.apiKey.deleteMany({ where: { businessId: CARRIER } });

    const key = generateApiKey();

    await prisma.apiKey.create({
      data: {
        name: "ERP",
        prefix: key.prefix,
        token_hash: key.tokenHash,
        scopes: ["deliveries:read"],
        businessId: CARRIER,
      },
    });

    const { configureIntegrationRateGuard, unlimitedIntegrationRateGuard } =
      await import("@/shared/integration/integration-rate-guard");

    const asked: Array<{ businessId: string; max: number }> = [];

    // The company has already spent its minute on its other keys.
    configureIntegrationRateGuard({
      ...unlimitedIntegrationRateGuard,
      allowBusiness: async (businessId, max) => {
        asked.push({ businessId, max });
        return false;
      },
    });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/integration/v1/deliveries",
        headers: { authorization: `Bearer ${key.token}` },
      });

      expect(response.statusCode, response.body).toBe(429);
      expect(JSON.parse(response.body).code).toBe("RATE_LIMITED");
      expect(Number(response.headers["retry-after"])).toBeGreaterThan(0);

      expect(asked).toEqual([
        { businessId: CARRIER, max: expect.any(Number) },
      ]);
    } finally {
      configureIntegrationRateGuard(unlimitedIntegrationRateGuard);
    }
  });
});
