import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomInt, randomUUID } from "node:crypto";

/**
 * What a refused request costs.
 *
 * The limiter ran AFTER `ensureAuthenticated`, so it could key by the user it
 * resolved — and so every request it answered 429 had already paid the
 * session lookup (the user, the business, the profile's permissions, the
 * refresh family). One valid token in a loop, the kind any driver has on their
 * phone, was "rate limited" while still draining the pool for every tenant.
 * And a token that did not verify was never counted at all.
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];
let UserRepository: typeof import("@/modules/user/repositories/user-repository").UserRepository;

// Fresh ids per run: the counters live in Redis across runs.
const BUSINESS = randomUUID();
const USER = randomUUID();

let token = "";

const octet = () => randomInt(1, 250);

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: BUSINESS,
      corporate_reason: "Transportadora do Limite",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(70000000000000 + randomInt(1, 9_000_000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `limite-${randomUUID()}@exemplo.com.br`,
    },
  });

  const user = await prisma.user.create({
    data: {
      id: USER,
      name: "Pessoa Insistente",
      email: `insistente-${randomUUID()}@exemplo.com.br`,
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

  ({ UserRepository } = await import(
    "@/modules/user/repositories/user-repository"
  ));

  ({ app } = await import("@/http"));
  await app.ready();

  // The limiter fails open until its Redis connection is ready, and a loop of
  // `inject` never yields to the I/O that would make it ready.
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

describe("one valid token in a loop", () => {
  it("stops costing the database once it is over the limit", async () => {
    const lookups = vi.spyOn(UserRepository.prototype, "findUserById");

    const call = () =>
      app.inject({
        method: "GET",
        url: "/user/me",
        // A new address every time: the bucket is the person, not the place.
        remoteAddress: `189.${octet()}.${octet()}.${octet()}`,
        headers: { authorization: `Bearer ${token}` },
      });

    let firstRefusal = -1;

    for (let index = 0; index < 400 && firstRefusal < 0; index += 1) {
      if ((await call()).statusCode === 429) firstRefusal = index;
    }

    expect(firstRefusal, "o limite nunca foi atingido").toBeGreaterThan(0);

    const lookupsAtLimit = lookups.mock.calls.length;

    const refusedAfter: number[] = [];

    for (let index = 0; index < 30; index += 1) {
      refusedAfter.push((await call()).statusCode);
    }

    const lookupsAfter = lookups.mock.calls.length;

    lookups.mockRestore();

    expect(refusedAfter.every((status) => status === 429)).toBe(true);

    // Thirty more refusals, and not one more session lookup.
    expect(lookupsAfter - lookupsAtLimit).toBe(0);
  }, 120_000);
});

describe("a token that does not verify", () => {
  // Each garbage token used to open a bucket of its own, so inventing a new
  // one per request reset every per-address limit to zero.
  it("is charged to the address, so inventing one per request buys nothing", async () => {
    const address = `177.${octet()}.${octet()}.${octet()}`;
    const statuses: number[] = [];

    for (let index = 0; index < 305; index += 1) {
      const response = await app.inject({
        method: "GET",
        url: "/user/me",
        remoteAddress: address,
        headers: { authorization: `Bearer garbage-${randomUUID()}` },
      });

      statuses.push(response.statusCode);
    }

    expect(statuses.slice(0, 300).every((status) => status === 401)).toBe(true);
    expect(statuses.slice(300)).toContain(429);
  }, 120_000);

  it("does not lift the login limit of an address (password spraying)", async () => {
    const address = `177.${octet()}.${octet()}.${octet()}`;
    const statuses: number[] = [];

    for (let index = 0; index < 10; index += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/user/session",
        remoteAddress: address,
        headers: { authorization: `Bearer ${token.slice(0, -4)}${index}abc` },
        payload: {
          email: `spray-${index}@example.com`,
          password: "nao-e-a-senha",
        },
      });

      statuses.push(response.statusCode);
    }

    expect(statuses.slice(0, 8).every((status) => status !== 429)).toBe(true);
    expect(statuses.slice(8)).toEqual([429, 429]);
  }, 120_000);
});
