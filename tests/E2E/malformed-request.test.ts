import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { sign } from "jsonwebtoken";
import auth from "@/config/auth";

/**
 * A request the server could not even parse, and the status it deserves.
 *
 * Fastify's default JSON parser refuses an EMPTY body whose header says
 * `application/json` — `FST_ERR_CTP_EMPTY_JSON_BODY`. The error handler here
 * recognised Zod errors and AppErrors and nothing else, so that refusal fell
 * through to the 500 at the bottom: "Internal server error", logged at error
 * level, for a request that was merely shaped oddly.
 *
 * It was not theoretical. Every DELETE the web sends carries
 * `Content-Type: application/json` and no body, so revoking an API key —
 * the action that stops somebody's ERP — answered 500 and revoked nothing.
 * The panel showed a red toast and the key stayed live.
 *
 * Two rules now hold, and they are different rules:
 *
 *   1. an EMPTY body with that header is accepted. It is ordinary HTTP, our
 *      own client does it, and an integrator's library will too;
 *   2. a body that is really malformed is refused with 4xx and never 5xx —
 *      a broken request is the caller's mistake, and answering 500 tells
 *      them to open a support ticket about our server instead.
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018fd500-0000-7000-8000-00000000000a";
const MANAGER = "018fd500-0000-7000-8000-0000000000a1";

let token = "";
let profileId = "";
let keyId = "";

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora do Parser",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(50000000000000 + Math.floor(Math.random() * 9000000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `parser-${randomUUID()}@exemplo.com.br`,
    },
  });

  // Integrations belong to Entregas (decision 4.3): the key routes answer
  // MODULE_NOT_ENABLED to a company without it.
  await prisma.businessEntitlement.create({
    data: { businessId: CARRIER, module: "DELIVERIES", enabled: true },
  });

  const profile = await prisma.profileAccess.create({
    data: {
      name: "Integrações",
      businessId: CARRIER,
      permissions: {
        create: [
          {
            permissionKey: "integration_manage",
            action: "Gerenciar integrações",
            canRead: true,
            canWrite: true,
            businessId: CARRIER,
          },
        ],
      },
    },
  });

  profileId = profile.id;

  await prisma.user.create({
    data: {
      id: MANAGER,
      name: "Gestor",
      email: `gestor-${randomUUID()}@exemplo.com.br`,
      password: "nao-usado",
      role: "BUSINESS_ADMIN",
      businessId: CARRIER,
      profileAccessId: profile.id,
    },
  });

  const familyId = randomUUID();

  await prisma.refreshToken.create({
    data: {
      userId: MANAGER,
      token_hash: randomUUID(),
      jti: randomUUID(),
      family_id: familyId,
      expires_in: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

  token = sign(
    {
      tokenType: "access",
      role: "BUSINESS_ADMIN",
      businessId: CARRIER,
      driverId: null,
      sessionVersion: 0,
      familyId,
    },
    auth.secret_token,
    { subject: MANAGER, expiresIn: "1h" },
  );

  ({ app } = await import("@/http"));
  await app.ready();

  const created = await app.inject({
    method: "POST",
    url: `/integrations/api-key/${CARRIER}`,
    headers: { authorization: `Bearer ${token}` },
    payload: { name: "ERP do teste", scopes: ["deliveries:read"] },
  });

  expect(created.statusCode, created.body.slice(0, 200)).toBe(201);

  keyId = created.json().data.id;
}, 180_000);

afterAll(async () => {
  await prisma.apiKey.deleteMany({ where: { businessId: CARRIER } });

  await prisma.refreshToken.deleteMany({ where: { userId: MANAGER } });
  await prisma.user.deleteMany({ where: { id: MANAGER } });

  await prisma.permission.deleteMany({ where: { profileAccessId: profileId } });
  await prisma.profileAccess.deleteMany({ where: { id: profileId } });
  await prisma.businessEntitlement.deleteMany({
    where: { businessId: CARRIER },
  });

  await prisma.business.deleteMany({ where: { id: CARRIER } });

  await prisma.$disconnect();
});

describe("a DELETE with the JSON header and no body", () => {
  it("revokes the key, which is what the caller asked for", async () => {
    const response = await app.inject({
      method: "DELETE",
      url: `/integrations/api-key/${keyId}/business/${CARRIER}`,
      headers: {
        authorization: `Bearer ${token}`,

        // The header every fetch wrapper sets, with the empty body every
        // DELETE has. This exact combination answered 500.
        "content-type": "application/json",
      },
    });

    expect(response.statusCode, response.body.slice(0, 300)).toBe(200);

    const stored = await prisma.apiKey.findUnique({ where: { id: keyId } });

    expect(stored?.revoked_at, "a chave não foi revogada").not.toBeNull();
  });
});

describe("a body that really is malformed", () => {
  it("is refused with 4xx, never with 500", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/integrations/api-key/${CARRIER}`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      payload: '{"name": "sem fechar"',
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(400);

    expect(
      response.statusCode,
      "um corpo quebrado do cliente virou erro do servidor",
    ).toBeLessThan(500);
  });

  it("says what is wrong instead of hiding behind a generic message", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/integrations/api-key/${CARRIER}`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      payload: "isto não é json",
    });

    expect(response.statusCode).toBeLessThan(500);

    // Whoever is integrating has to be able to act on the answer.
    expect(response.body.toLowerCase()).not.toContain("internal server error");
  });
});

describe("an empty body where the route needs one", () => {
  it("is a validation error naming the fields, not a parser error", async () => {
    /**
     * The other half of accepting empty bodies: a route WITH a body schema
     * must still refuse. What changes is the shape of the refusal — a 400
     * listing what is missing, rather than a parser complaining about the
     * content type, which tells the caller nothing about the payload.
     */
    const response = await app.inject({
      method: "POST",
      url: `/integrations/api-key/${CARRIER}`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
    });

    expect(response.statusCode).toBe(400);
    // pt-BR at the source: the first refused field's sentence, not the
    // English "Validation Error" every client used to print.
    expect(response.json().message).toBe(response.json().issues[0]);
    expect(response.json().message).not.toMatch(/Required|Expected/);

    // "Naming the fields" is the list itself. This route's 400 schema used to
    // strip it on the way out, and the test above still passed.
    expect(response.json().code).toBe("VALIDATION_ERROR");
    expect(response.json().issues?.length).toBeGreaterThan(0);
  });
});
