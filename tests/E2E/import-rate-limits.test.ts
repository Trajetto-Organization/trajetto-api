import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomInt, randomUUID } from "node:crypto";

/**
 * How often one person may import.
 *
 * Both imports parse on the event loop — a spreadsheet of tens of thousands
 * of rows, up to 25 NF-e of half a megabyte each — and neither had a limit of
 * its own, only the global 300 a minute. A loop of full imports from one
 * account froze the replica for every tenant on it.
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

// Fresh ids per run: the counters live in Redis across runs.
const BUSINESS = randomUUID();
const USER = randomUUID();

let token = "";

const octet = () => randomInt(1, 250);

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: BUSINESS,
      corporate_reason: "Transportadora da Importação",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(71000000000000 + randomInt(1, 9_000_000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `importa-${randomUUID()}@exemplo.com.br`,
    },
  });

  const user = await prisma.user.create({
    data: {
      id: USER,
      name: "Pessoa Importadora",
      email: `importadora-${randomUUID()}@exemplo.com.br`,
      password: "nao-usado",
      role: "BUSINESS_ADMIN",
      businessId: BUSINESS,
    },
  });

  const { issueSessionTokenPair } = await import(
    "@/modules/user/services/session-service"
  );

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

  token = pair.token;

  ({ app } = await import("@/http"));
  await app.ready();

  // The limiter fails open until its Redis connection is ready.
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
  await prisma.refreshToken.deleteMany({ where: { userId: USER } });
  await prisma.user.deleteMany({ where: { id: USER } });
  await prisma.business.deleteMany({ where: { id: BUSINESS } });

  await app?.close();
  await prisma.$disconnect();
}, 60_000);

async function hammer(url: string, times: number): Promise<number[]> {
  const statuses: number[] = [];

  for (let index = 0; index < times; index += 1) {
    const response = await app.inject({
      method: "POST",
      url,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });

    statuses.push(response.statusCode);
  }

  return statuses;
}

describe("the spreadsheet import", () => {
  it("answers 429 past six a minute", async () => {
    const statuses = await hammer(`/import/import-spreadsheet/${BUSINESS}`, 7);

    expect(statuses.slice(0, 6)).not.toContain(429);
    expect(statuses[6]).toBe(429);
  });
});

describe("the NF-e import", () => {
  it("answers 429 past ten a minute", async () => {
    const statuses = await hammer(`/delivery/import-xml/${BUSINESS}`, 11);

    expect(statuses.slice(0, 10)).not.toContain(429);
    expect(statuses[10]).toBe(429);
  });
});
