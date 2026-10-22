import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomInt, randomUUID } from "node:crypto";

import { generateApiKey } from "@/shared/integration/api-key-rules";

/**
 * The public API's limits, as a caller meets them.
 *
 * Two holes, one file:
 *
 * - Each of the five /integration/v1 routes had its own bucket per key, so a
 *   key provisioned at 60/min got 60/min on EACH route: five times what the
 *   product promised and the customer sized their integration by.
 * - The per-key limiter could only run after `ensureApiKey` had looked the key
 *   up, and a forged key is refused (401) before it runs. A flood of
 *   well-formed made-up keys therefore cost one database lookup each, with no
 *   limit at all, on the pool every tenant shares.
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018f5000-0000-7000-8000-0000000007a1";

/** Fresh addresses per run: the counters live in Redis across runs. */
const octet = () => randomInt(1, 250);
const address = () => `198.18.${octet()}.${octet()}`;

async function seedKey(options: {
  scopes: string[];
  ratePerMinute?: number;
}): Promise<string> {
  const key = generateApiKey();

  await prisma.apiKey.create({
    data: {
      name: "Integração de teste",
      prefix: key.prefix,
      token_hash: key.tokenHash,
      scopes: options.scopes,
      businessId: CARRIER,
      ...(options.ratePerMinute !== undefined && {
        rate_limit_per_minute: options.ratePerMinute,
      }),
    },
  });

  return key.token;
}

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora dos Limites",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: "44555666000177",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `limites-${randomUUID()}@exemplo.com.br`,
    },
  });

  await prisma.businessEntitlement.create({
    data: { businessId: CARRIER, module: "DELIVERIES", enabled: true },
  });

  ({ app } = await import("@/http"));
  await app.ready();
}, 90_000);

afterAll(async () => {
  await app?.close();

  await prisma.apiKey.deleteMany({ where: { businessId: CARRIER } });
  await prisma.businessEntitlement.deleteMany({
    where: { businessId: CARRIER },
  });
  await prisma.business.deleteMany({ where: { id: CARRIER } });

  await prisma.$disconnect();
});

const call = (url: string, token: string, remoteAddress = "127.0.0.1") =>
  app.inject({
    method: "GET",
    url: `/integration/v1${url}`,
    remoteAddress,
    headers: { authorization: `Bearer ${token}` },
  });

describe("a flood of made-up keys", () => {
  it("is cut off by address before it reaches the database", async () => {
    const attacker = address();
    const statuses: number[] = [];

    for (let attempt = 0; attempt < 40; attempt += 1) {
      // Well-formed, so it gets past parsing to the lookup; never stored.
      statuses.push(
        (await call("/deliveries?limit=1", generateApiKey().token, attacker))
          .statusCode,
      );
    }

    expect(statuses.slice(0, 30).every((status) => status === 401)).toBe(true);
    expect(statuses.slice(30)).toContain(429);

    const refusal = await call(
      "/deliveries?limit=1",
      generateApiKey().token,
      attacker,
    );

    expect(refusal.statusCode).toBe(429);
    expect(refusal.json().code).toBe("RATE_LIMITED");

    // The documented 429 tells the caller to wait `retry-after`; the window is
    // fixed and never longer than a minute, so a minute always clears it.
    expect(Number(refusal.headers["retry-after"])).toBeGreaterThan(0);
    expect(Number(refusal.headers["retry-after"])).toBeLessThanOrEqual(60);
  });

  it("does not spend anybody else's budget", async () => {
    const readKey = await seedKey({ scopes: ["deliveries:read"] });

    const response = await call("/deliveries?limit=1", readKey, address());

    expect(response.statusCode).toBe(200);
  });

  it("does not count a genuine key's calls as failures", async () => {
    const readKey = await seedKey({ scopes: ["deliveries:read"] });
    const integrator = address();

    const statuses: number[] = [];

    for (let attempt = 0; attempt < 35; attempt += 1) {
      statuses.push(
        (await call("/deliveries?limit=1", readKey, integrator)).statusCode,
      );
    }

    expect(statuses.every((status) => status === 200)).toBe(true);
  });
});

describe("the ceiling a key carries", () => {
  it("is one ceiling across every endpoint, not one per endpoint", async () => {
    const tight = await seedKey({
      scopes: ["deliveries:read", "routes:read", "events:read"],
      // The smallest the schema accepts.
      ratePerMinute: 10,
    });

    const statuses: number[] = [];

    for (let attempt = 0; attempt < 6; attempt += 1) {
      statuses.push((await call("/deliveries?limit=1", tight)).statusCode);
      statuses.push(
        (await call(`/deliveries/${randomUUID()}`, tight)).statusCode,
      );
    }

    // Twelve calls against a ceiling of ten: per-endpoint buckets let all
    // twelve through.
    expect(
      statuses.filter((status) => status === 429).length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      statuses.filter((status) => status !== 429).length,
    ).toBeLessThanOrEqual(10);
  });

  it("still keeps two keys of one company apart", async () => {
    const first = await seedKey({
      scopes: ["deliveries:read"],
      ratePerMinute: 10,
    });
    const second = await seedKey({
      scopes: ["deliveries:read"],
      ratePerMinute: 10,
    });

    for (let attempt = 0; attempt < 12; attempt += 1) {
      await call("/deliveries?limit=1", first);
    }

    expect((await call("/deliveries?limit=1", second)).statusCode).toBe(200);
  });

  it("tells the caller where it stands", async () => {
    const key = await seedKey({ scopes: ["routes:read"], ratePerMinute: 10 });

    const response = await call("/routes?limit=1", key);

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-ratelimit-limit"]).toBe("10");
    expect(response.headers["x-ratelimit-remaining"]).toBe("9");
  });
});
