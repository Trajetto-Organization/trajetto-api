import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { sign } from "jsonwebtoken";

import { randomUUID } from "node:crypto";

import auth from "@/config/auth";
import { createPrismaClient } from "@/shared/database/database-client";
import { generateApiKey } from "@/shared/integration/api-key-rules";
import { DeliveryGeocodingRepository } from "@/shared/delivery/geocoding/geocoding-repository";
import { deliveryAddressKey } from "@/shared/delivery/address-key";

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
 * found afterwards. And, since 14/11/2026, that a delivery created without
 * a point at a door the company already located takes that point, as
 * GEOCODER ("Pelo endereço"), with the geocoder off — never another
 * company's — and that the ERP's resend of it is still a replay.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018fe100-0000-7000-8000-00000000000a";
const SHIPPER = "018fe100-0000-7000-8000-0000000000f1";
/** Another carrier with a point at the owner's address. */
const OTHER = "018fe100-0000-7000-8000-00000000000b";
const OTHER_SHIPPER = "018fe100-0000-7000-8000-0000000000f2";

/** The owner's report of 14/11/2026, as typed. */
const LIPOLD = {
  street: "Rua Doutor Lipold",
  address_number: "10",
  neighborhood: "Carangola",
  city: "Petrópolis",
  uf: "RJ",
  cep: "25715000",
};
const LIPOLD_PIN = { latitude: -22.4561, longitude: -43.1702 };

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

  await prisma.business.create({
    data: {
      id: OTHER,
      corporate_reason: "Outra Transportadora",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "2",
      cnpj: String(63000000000000 + Math.floor(Math.random() * 9000000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999998",
      email: `${OTHER}@exemplo.com.br`,
    },
  });
  await prisma.shipper.create({
    data: { id: OTHER_SHIPPER, name: "Embarcador", businessId: OTHER },
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
      geo_copied_from: true,
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
    // Another door: at the pinned one's it would take that point.
    const plain = await panelCreate({
      recipient_name: "Fila sem Ponto",
      street: "Rua Direita",
    });

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

describe("the point of another delivery at the same door", () => {
  it("is taken by a create without coordinates, as GEOCODER at the number, and the queue skips it", async () => {
    // Another company's point at the very same address: never taken.
    await prisma.delivery.create({
      data: {
        ...LIPOLD,
        recipient_name: "Cliente da outra",
        businessId: OTHER,
        shipperId: OTHER_SHIPPER,
        address_key: deliveryAddressKey(LIPOLD),
        latitude: -22.9,
        longitude: -43.9,
        geo_source: "MANUAL",
        geo_updated_at: new Date(),
      },
    });

    const alone = await panelCreate({
      ...LIPOLD,
      recipient_name: "Primeira no Lipold",
    });

    expect(alone.statusCode, alone.body).toBe(201);
    expect(await pointOf(alone.json().data.id)).toMatchObject({
      latitude: null,
      geo_source: null,
    });

    // The dispatcher pins it on the map's click...
    await prisma.delivery.update({
      where: { id: alone.json().data.id },
      data: { ...LIPOLD_PIN, geo_source: "MANUAL", geo_updated_at: new Date() },
    });

    // ...and the next one at that door, however it is spelled, has it.
    const second = await panelCreate({
      ...LIPOLD,
      street: "R. Dr. Lipold",
      cep: "25715-000",
      recipient_name: "Segunda no Lipold",
    });

    expect(second.statusCode, second.body).toBe(201);
    expect(await pointOf(second.json().data.id)).toMatchObject({
      ...LIPOLD_PIN,
      geo_source: "GEOCODER",
      geo_precision: "ADDRESS",
      geocode_status: "RESOLVED",
      // The pin's later changes reach it (followSource).
      geo_copied_from: alone.json().data.id,
    });

    const claimed = (
      await new DeliveryGeocodingRepository().claim(1_000, new Date())
    ).map((claim) => claim.id);

    expect(claimed).not.toContain(second.json().data.id);
  });

  it("is taken by the public create too, and the ERP's resend is still a replay", async () => {
    const key = `pedido-${randomUUID()}`;
    const body = { ...LIPOLD, recipient_name: "Pedido no Lipold" };

    const first = await publicCreate(body, key);

    expect(first.statusCode, first.body).toBe(201);
    expect(await pointOf(first.json().id)).toMatchObject({
      ...LIPOLD_PIN,
      geo_source: "GEOCODER",
    });

    const again = await publicCreate(body, key);

    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().id).toBe(first.json().id);
  });

  it("is read one index entry per source, however busy the door", async () => {
    // The two probes the create and the job share (readDoorCandidates),
    // the propagation's UPDATE (writePointToDoor) and the pin's follow-up
    // (followSource), in the shape they run. With sequential and bitmap
    // scans off, only an index scan is left: delivery_address_key_idx must
    // be the probes' one, and no Sort may follow it — a sort would mean the
    // probe reads and orders every point the door ever had instead of
    // stopping at the first. The GEOCODER probe's join to the copy's root
    // is a primary-key probe per entry, keeping the index's order.
    const door = `d."businessId" = '${CARRIER}'
      AND d."address_key" = '${deliveryAddressKey(LIPOLD)}'
      AND d."id" <> ''`;
    const newest = `ORDER BY d."geo_updated_at" DESC NULLS LAST, d."id" DESC LIMIT 1`;

    const plans = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off");
      await tx.$executeRawUnsafe("SET LOCAL enable_bitmapscan = off");

      const explain = async (sql: string) =>
        (
          await tx.$queryRawUnsafe<Array<{ "QUERY PLAN": string }>>(
            `EXPLAIN ${sql}`,
          )
        )
          .map((row) => row["QUERY PLAN"])
          .join("\n");

      return {
        manual: await explain(
          `SELECT d."latitude", d."id" FROM "delivery" AS d WHERE ${door}
            AND d."latitude" IS NOT NULL AND d."longitude" IS NOT NULL
            AND d."geo_source" = 'MANUAL' ${newest}`,
        ),
        geocoded: await explain(
          `SELECT d."latitude",
              CASE WHEN r."businessId" = d."businessId"
                AND r."address_key" = d."address_key"
                THEN r."id" ELSE d."id" END
            FROM "delivery" AS d
            LEFT JOIN "delivery" AS r ON r."id" = d."geo_copied_from"
            WHERE ${door}
              AND d."latitude" IS NOT NULL AND d."longitude" IS NOT NULL
              AND d."geo_source" = 'GEOCODER'
              AND d."geo_precision" IN ('ADDRESS', 'STREET')
              AND (r."id" IS NULL
                OR r."businessId" <> d."businessId"
                OR r."address_key" IS DISTINCT FROM d."address_key"
                OR (r."latitude" = d."latitude" AND r."longitude" = d."longitude"))
            ${newest}`,
        ),
        write: await explain(
          `UPDATE "delivery" AS d SET "geocode_status" = 'RESOLVED'
            WHERE ${door} AND d."status" IN ('PENDING', 'IN_TRANSIT')
              AND d."latitude" IS NULL AND d."geo_source" IS NULL`,
        ),
        follow: await explain(
          `UPDATE "delivery" AS d SET "geocode_status" = 'RESOLVED'
            FROM (
              SELECT "id" FROM "delivery"
              WHERE "businessId" = '${CARRIER}'
                AND "geo_copied_from" = '${randomUUID()}'
                AND "status" IN ('PENDING', 'IN_TRANSIT')
                AND "id" <> ''
                AND "geo_source" = 'GEOCODER'
                AND "latitude" = -22.4 AND "longitude" = -43.1
                AND "address_key" IS NOT DISTINCT FROM '${deliveryAddressKey(LIPOLD)}'
              ORDER BY "id" || ''
              FOR NO KEY UPDATE
            ) AS follower
            WHERE d."id" = follower."id"`,
        ),
      };
    });

    for (const probe of [plans.manual, plans.geocoded]) {
      expect(probe).toContain("delivery_address_key_idx");
      expect(probe).not.toMatch(/\bSort\b/);
    }
    expect(plans.geocoded).toContain("delivery_pkey");

    // The propagation reads the door's rows without a source, not all.
    expect(plans.write).toContain("delivery_address_key_idx");
    expect(plans.write).toMatch(/Index Cond: .*geo_source IS NULL/);

    // The follow-up reads the source's open copies, not the door nor the
    // company (a bare ORDER BY "id" took delivery_businessId_id_idx, whose
    // order is the id's), locks them in id order (LockRows over the Sort)
    // and writes each one by its primary key.
    expect(plans.follow).toMatch(
      /LockRows[\s\S]*Sort[\s\S]*delivery_geo_copied_from_idx/,
    );
    expect(plans.follow).not.toContain("delivery_businessId_id_idx");
    expect(plans.follow).toContain("delivery_pkey");
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
