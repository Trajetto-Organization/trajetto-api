import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { sign } from "jsonwebtoken";

import { randomUUID } from "node:crypto";

import auth from "@/config/auth";
import { createPrismaClient } from "@/shared/database/database-client";
import { generateApiKey } from "@/shared/integration/api-key-rules";
import { DeliveryGeocodingRepository } from "@/shared/delivery/geocoding/geocoding-repository";

/**
 * Plan of 02/11/2026, E1: the coordinates a company already has, accepted on
 * the create — the panel's form and the public API here (the spreadsheet's
 * columns go through the same repository create, see import-spreadsheet) —
 * over HTTP and against Postgres.
 *
 * What only this file proves: the point lands in the columns as the address
 * point with geo_source MANUAL; the geocoder's queue, the real SQL claim,
 * never takes such a row (it would be the geocoder overwriting a point a
 * person gave); half a pair is refused with nothing written; and the public
 * create's replay compares the point it wrote, but not one the geocoder
 * found afterwards.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018fe100-0000-7000-8000-00000000000a";
const SHIPPER = "018fe100-0000-7000-8000-0000000000f1";

const SE = { latitude: -23.5505, longitude: -46.6333 };

let token: string;
let apiKey: string;

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora das Coordenadas",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(62000000000000 + Math.floor(Math.random() * 9000000)),
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

  const key = generateApiKey();

  await prisma.apiKey.create({
    data: {
      name: "ERP com coordenadas",
      prefix: key.prefix,
      token_hash: key.tokenHash,
      scopes: ["deliveries:write"],
      businessId: CARRIER,
    },
  });

  apiKey = key.token;

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

const panelCreate = (body: Record<string, unknown>) =>
  app.inject({
    method: "POST",
    url: `/delivery/create-delivery/${CARRIER}`,
    headers: { authorization: `Bearer ${token}` },
    payload: {
      shipperId: SHIPPER,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Praça da Sé",
      ...body,
    },
  });

const publicCreate = (body: Record<string, unknown>, idempotencyKey: string) =>
  app.inject({
    method: "POST",
    url: "/integration/v1/deliveries",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
      "idempotency-key": idempotencyKey,
    },
    payload: JSON.stringify({
      shipper_id: SHIPPER,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Praça da Sé",
      ...body,
    }),
  });

const pointOf = (id: string) =>
  prisma.delivery.findUniqueOrThrow({
    where: { id },
    select: {
      latitude: true,
      longitude: true,
      geo_source: true,
      geo_updated_at: true,
      geo_precision: true,
      geocode_status: true,
    },
  });

describe("the panel's create", () => {
  it("stores the point it was given as the MANUAL address point", async () => {
    const response = await panelCreate({
      recipient_name: "Padaria com Ponto",
      ...SE,
    });

    expect(response.statusCode, response.body).toBe(201);

    const row = await pointOf(response.json().data.id);

    expect(row).toMatchObject({
      ...SE,
      geo_source: "MANUAL",
      geo_precision: null,
      geocode_status: null,
    });
    expect(row.geo_updated_at).toBeInstanceOf(Date);
  });

  it("refuses half a point and writes nothing", async () => {
    const response = await panelCreate({
      recipient_name: "Padaria Meio Ponto",
      latitude: SE.latitude,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(JSON.stringify(response.json())).toContain(
      "Informe a latitude e a longitude juntas",
    );
    expect(
      await prisma.delivery.count({
        where: { businessId: CARRIER, recipient_name: "Padaria Meio Ponto" },
      }),
    ).toBe(0);
  });

  it("refuses a swapped pair, which falls outside Brazil", async () => {
    const response = await panelCreate({
      recipient_name: "Padaria Trocada",
      latitude: SE.longitude,
      longitude: SE.latitude,
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.stringify(response.json())).toContain("não estão trocadas");
  });
});

describe("the geocoder's queue", () => {
  it("never claims a delivery created with a point, and still claims one created without", async () => {
    const pinned = await panelCreate({
      recipient_name: "Fila com Ponto",
      ...SE,
    });
    const plain = await panelCreate({ recipient_name: "Fila sem Ponto" });

    expect(pinned.statusCode).toBe(201);
    expect(plain.statusCode).toBe(201);

    const claimed = (
      await new DeliveryGeocodingRepository().claim(1_000, new Date())
    ).map((claim) => claim.id);

    expect(claimed).not.toContain(pinned.json().data.id);
    expect(claimed).toContain(plain.json().data.id);

    // And the point is still the one the dispatcher gave.
    expect(await pointOf(pinned.json().data.id)).toMatchObject({
      ...SE,
      geo_source: "MANUAL",
    });
  });
});

describe("the public create", () => {
  it("stores the point and replays the same body as the same delivery", async () => {
    const key = `pedido-${randomUUID()}`;
    const body = { recipient_name: "Mercado com Ponto", ...SE };

    const first = await publicCreate(body, key);
    const again = await publicCreate(body, key);

    expect(first.statusCode, first.body).toBe(201);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().id).toBe(first.json().id);

    expect(await pointOf(first.json().id)).toMatchObject({
      ...SE,
      geo_source: "MANUAL",
    });
  });

  it("refuses the same key with a corrected point, pointing at what it created", async () => {
    const key = `pedido-${randomUUID()}`;

    const first = await publicCreate(
      { recipient_name: "Mercado Corrigido", ...SE },
      key,
    );
    const corrected = await publicCreate(
      {
        recipient_name: "Mercado Corrigido",
        latitude: -23.551,
        longitude: SE.longitude,
      },
      key,
    );

    expect(first.statusCode).toBe(201);
    expect(corrected.statusCode).toBe(409);
    expect(corrected.json()).toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSED",
      delivery_id: first.json().id,
    });
  });

  it("still replays a body without a point after the geocoder found the address", async () => {
    const key = `pedido-${randomUUID()}`;
    const body = { recipient_name: "Mercado Geocodificado" };

    const first = await publicCreate(body, key);

    expect(first.statusCode).toBe(201);

    // What the geocoder's settle writes for a RESOLVED address.
    await prisma.delivery.update({
      where: { id: first.json().id },
      data: {
        ...SE,
        geo_source: "GEOCODER",
        geo_precision: "ADDRESS",
        geocode_status: "RESOLVED",
        geo_updated_at: new Date(),
      },
    });

    const again = await publicCreate(body, key);

    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().id).toBe(first.json().id);
  });

  it("refuses half a point with the field in front of the sentence", async () => {
    const response = await publicCreate(
      { recipient_name: "Mercado Meio Ponto", longitude: SE.longitude },
      `pedido-${randomUUID()}`,
    );

    expect(response.statusCode).toBe(400);
    expect(response.json().issues).toContain(
      "latitude: Informe a latitude e a longitude juntas, ou nenhuma das duas.",
    );
  });
});
