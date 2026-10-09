import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { sign } from "jsonwebtoken";

import { randomUUID } from "node:crypto";

import auth from "@/config/auth";

/**
 * A panel create sent twice, over HTTP and against Postgres (IDEMP-14).
 *
 * The unit suite proves the use cases' decisions against fakes. What only
 * this file proves is the wiring the fakes cannot: the header is read by the
 * controller, the key lands in the column, the unique
 * (businessId, client_submission_id) index answers the replay lookup — and a
 * request WITHOUT the header, which is what every web older than this API
 * sends, still creates what it always created.
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018fdcc0-0000-7000-8000-00000000000a";
const SHIPPER = "018fdcc0-0000-7000-8000-0000000000f1";

let token: string;

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora do Duplo Clique",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(61000000000000 + Math.floor(Math.random() * 9000000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `${CARRIER}@exemplo.com.br`,
    },
  });

  await prisma.businessEntitlement.create({
    data: { businessId: CARRIER, module: "DELIVERIES", enabled: true },
  });

  await prisma.shipper.create({
    data: { id: SHIPPER, name: "Embarcador", businessId: CARRIER },
  });

  const userId = randomUUID();
  const familyId = randomUUID();

  await prisma.user.create({
    data: {
      id: userId,
      name: "Despachante",
      email: `${userId}@exemplo.com.br`,
      password: "not-used-here",
      role: "BUSINESS_ADMIN",
      businessId: CARRIER,
    },
  });

  await prisma.refreshToken.create({
    data: {
      userId,
      token_hash: randomUUID(),
      jti: randomUUID(),
      family_id: familyId,
      expires_in: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

  token = sign(
    { tokenType: "access", sessionVersion: 0, familyId },
    auth.secret_token,
    { subject: userId, expiresIn: "15m" },
  );

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

const createDelivery = (recipient: string, key?: string) =>
  app.inject({
    method: "POST",
    url: `/delivery/create-delivery/${CARRIER}`,
    headers: {
      authorization: `Bearer ${token}`,
      ...(key && { "idempotency-key": key }),
    },
    payload: {
      shipperId: SHIPPER,
      recipient_name: recipient,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Praça da Sé",
    },
  });

describe("a delivery saved twice from the panel", () => {
  it("is one delivery when the form's key is the same", async () => {
    const key = randomUUID();

    const first = await createDelivery("Padaria Chave", key);
    const again = await createDelivery("Padaria Chave", key);

    expect(first.statusCode, first.body).toBe(201);
    expect(again.statusCode, again.body).toBe(201);

    expect(again.json().data.id).toBe(first.json().data.id);

    expect(
      await prisma.delivery.count({
        where: { businessId: CARRIER, recipient_name: "Padaria Chave" },
      }),
    ).toBe(1);

    // Announced once: the replay writes nothing, webhooks included.
    expect(
      await prisma.delivery.findUniqueOrThrow({
        where: { id: first.json().data.id },
        select: { client_submission_id: true },
      }),
    ).toEqual({ client_submission_id: key });
  });

  it("is two deliveries without a key, as an older web sends them", async () => {
    const first = await createDelivery("Padaria Sem Chave");
    const again = await createDelivery("Padaria Sem Chave");

    expect(first.statusCode, first.body).toBe(201);
    expect(again.statusCode, again.body).toBe(201);

    expect(
      await prisma.delivery.count({
        where: { businessId: CARRIER, recipient_name: "Padaria Sem Chave" },
      }),
    ).toBe(2);
  });
});
