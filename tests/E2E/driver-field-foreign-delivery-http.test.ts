import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { sign } from "jsonwebtoken";

import { randomUUID } from "node:crypto";

import auth from "@/config/auth";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * The driver's field routes answer another company's delivery exactly like
 * a missing one (decision 11.3): 404 DELIVERY_NOT_FOUND, over real HTTP.
 *
 * Arrival and proof answered a made-up id with a code-less 400 and another
 * carrier's delivery with 403 "não pertence à empresa informada": the
 * difference told any driver token which delivery ids exist elsewhere. The
 * app's outbox treats both as a permanent refusal, so nothing changes there.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018fe800-0000-7000-8000-00000000000a";
const OTHER = "018fe800-0000-7000-8000-00000000000b";
const DRIVER = "018fe800-0000-7000-8000-0000000000d1";
const OTHER_DRIVER = "018fe800-0000-7000-8000-0000000000d2";
const OTHER_SHIPPER = "018fe800-0000-7000-8000-0000000000f2";
const FOREIGN_DELIVERY = "018fe800-0000-7000-8000-0000000000a2";
const MADE_UP = "018fe800-0000-7000-8000-0000000000a9";

let driverToken = "";

async function seedBusiness(id: string, cnpj: string): Promise<void> {
  await prisma.business.create({
    data: {
      id,
      corporate_reason: `Transportadora ${cnpj}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj,
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `${id}@exemplo.com.br`,
    },
  });

  await prisma.businessEntitlement.create({
    data: { businessId: id, module: "DELIVERIES", enabled: true },
  });
}

async function seedDriver(
  id: string,
  businessId: string,
  cpf: string,
): Promise<void> {
  await prisma.driver.create({
    data: {
      id,
      name: "Motorista",
      birth_date: new Date("1990-01-01"),
      cnh: `cnh-${cpf}`,
      cpf,
      rg: `rg-${cpf}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId,
    },
  });
}

beforeAll(async () => {
  await seedBusiness(CARRIER, "44555666000101");
  await seedBusiness(OTHER, "44555666000202");

  await seedDriver(DRIVER, CARRIER, "cpf-campo-1");
  await seedDriver(OTHER_DRIVER, OTHER, "cpf-campo-2");

  await prisma.shipper.create({
    data: { id: OTHER_SHIPPER, name: "Embarcador Alheio", businessId: OTHER },
  });

  // On the street at the other carrier.
  await prisma.delivery.create({
    data: {
      id: FOREIGN_DELIVERY,
      recipient_name: "Cliente alheio",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      businessId: OTHER,
      shipperId: OTHER_SHIPPER,
      driverId: OTHER_DRIVER,
      status: "IN_TRANSIT",
    },
  });

  const userId = randomUUID();
  const familyId = randomUUID();

  await prisma.user.create({
    data: {
      id: userId,
      name: "Motorista",
      email: `${userId}@exemplo.com.br`,
      password: "not-used-here",
      role: "BUSINESS_USER",
      businessId: CARRIER,
      driverId: DRIVER,
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

  driverToken = sign(
    { tokenType: "access", sessionVersion: 0, familyId },
    auth.secret_token,
    {
      subject: userId,
      expiresIn: "15m",
    },
  );

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

const routes = {
  arrival: (deliveryId: string) => ({
    url: `/delivery/arrival/${deliveryId}/business/${CARRIER}`,
    payload: {
      client_submission_id: randomUUID(),
      latitude: -23.55,
      longitude: -46.63,
    },
  }),
  proof: (deliveryId: string) => ({
    url: `/delivery/proof/${deliveryId}/business/${CARRIER}`,
    payload: {
      client_submission_id: randomUUID(),
      photo: `deliveryProofs/${deliveryId}/canhoto.jpg`,
      received_by: "Maria Recebedora",
    },
  }),
};

describe.each(Object.entries(routes))("the %s route", (_name, route) => {
  it("answers another company's delivery exactly like a missing one", async () => {
    const answers = await Promise.all(
      [FOREIGN_DELIVERY, MADE_UP].map(async (deliveryId) => {
        const response = await app.inject({
          method: "POST",
          ...route(deliveryId),
          headers: { authorization: `Bearer ${driverToken}` },
        });

        return {
          status: response.statusCode,
          code: response.json().code,
          message: response.json().message,
        };
      }),
    );

    expect(answers[0]).toMatchObject({
      status: 404,
      code: "DELIVERY_NOT_FOUND",
    });
    expect(answers[1]).toEqual(answers[0]);
  });
});

it("left the other company's delivery as it was", async () => {
  const delivery = await prisma.delivery.findUniqueOrThrow({
    where: { id: FOREIGN_DELIVERY },
  });

  expect(delivery.status).toBe("IN_TRANSIT");
  expect(
    await prisma.deliveryEvent.count({
      where: { deliveryId: FOREIGN_DELIVERY },
    }),
  ).toBe(0);
});
