import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import { sign } from "jsonwebtoken";
import auth from "@/config/auth";

import { generateApiKey } from "@/shared/integration/api-key-rules";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * The occurrence type's ERP code over HTTP and the real index (plan of
 * 02/11/2026, L8): the 409 comes from Postgres' (businessId, code) unique —
 * Prisma 7 names the index, not the columns, so only the real database proves
 * the use case recognises it — another company may hold the same code, a
 * type of another company is missing, and the code reaches the integrator in
 * /integration/v1/events on the occurrence.reported event.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018fe410-0000-7000-8000-00000000000a";
const OTHER = "018fe410-0000-7000-8000-00000000000b";

const ADMIN = "018fe410-0000-7000-8000-0000000000a1";
const OTHER_ADMIN = "018fe410-0000-7000-8000-0000000000a2";

const SHIPPER = "018fe410-0000-7000-8000-0000000000e1";

const tokens: Record<string, string> = {};
let eventsKey = "";

async function tokenFor(userId: string): Promise<string> {
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
    { tokenType: "access", sessionVersion: 0, familyId },
    auth.secret_token,
    { subject: userId, expiresIn: "1h" },
  );
}

async function seedCompany(id: string, adminId: string): Promise<void> {
  await prisma.business.create({
    data: {
      id,
      corporate_reason: `Transportadora ${id.slice(-2)}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(59000000000000 + Math.floor(Math.random() * 9000000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `codigo-${randomUUID()}@exemplo.com.br`,
    },
  });

  await prisma.businessEntitlement.create({
    data: { businessId: id, module: "DELIVERIES", enabled: true },
  });

  await prisma.user.create({
    data: {
      id: adminId,
      name: `Admin ${id.slice(-2)}`,
      email: `admin-${randomUUID()}@exemplo.com.br`,
      password: "nao-usado",
      role: "BUSINESS_ADMIN",
      businessId: id,
    },
  });

  tokens[adminId] = await tokenFor(adminId);
}

beforeAll(async () => {
  await seedCompany(CARRIER, ADMIN);
  await seedCompany(OTHER, OTHER_ADMIN);

  await prisma.shipper.create({
    data: { id: SHIPPER, name: "Embarcador", businessId: CARRIER },
  });

  const key = generateApiKey();

  await prisma.apiKey.create({
    data: {
      name: "ERP",
      prefix: key.prefix,
      token_hash: key.tokenHash,
      scopes: ["events:read"],
      businessId: CARRIER,
    },
  });

  eventsKey = key.token;

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

function createType(
  userId: string,
  businessId: string,
  body: Record<string, unknown>,
) {
  return app.inject({
    method: "POST",
    url: `/occurrence-type/create-occurrence-type/${businessId}`,
    headers: { authorization: `Bearer ${tokens[userId]}` },
    payload: body,
  });
}

function updateType(
  userId: string,
  businessId: string,
  occurrenceTypeId: string,
  body: Record<string, unknown>,
) {
  return app.inject({
    method: "PATCH",
    url: `/occurrence-type/update-occurrence-type/${occurrenceTypeId}/business/${businessId}`,
    headers: { authorization: `Bearer ${tokens[userId]}` },
    payload: body,
  });
}

const typeNamed = (businessId: string, name: string) =>
  prisma.occurrenceType.findFirstOrThrow({ where: { businessId, name } });

describe("the occurrence type's ERP code, over HTTP", () => {
  it("is stored, and a second type with it in the same company is 409 from the index", async () => {
    const created = await createType(ADMIN, CARRIER, {
      name: "Cliente ausente",
      code: "AUS-01",
    });

    expect(created.statusCode, created.body).toBe(201);
    expect((await typeNamed(CARRIER, "Cliente ausente")).code).toBe("AUS-01");

    const twin = await createType(ADMIN, CARRIER, {
      name: "Destinatário viajou",
      code: "AUS-01",
    });

    expect(twin.statusCode).toBe(409);
    expect(twin.json()).toMatchObject({
      code: "OCCURRENCE_TYPE_CODE_TAKEN",
      message: "Já existe um tipo de ocorrência com este código nesta empresa.",
    });
  });

  it("lets another company use the same code", async () => {
    const response = await createType(OTHER_ADMIN, OTHER, {
      name: "Cliente ausente",
      code: "AUS-01",
    });

    expect(response.statusCode, response.body).toBe(201);
  });

  it("refuses an edit onto a taken code, and answers another company's type as missing", async () => {
    await createType(ADMIN, CARRIER, { name: "Recusou a carga", code: "REC" });

    const refused = await typeNamed(CARRIER, "Recusou a carga");

    const taken = await updateType(ADMIN, CARRIER, refused.id, {
      code: "AUS-01",
    });

    expect(taken.statusCode).toBe(409);
    expect(taken.json().code).toBe("OCCURRENCE_TYPE_CODE_TAKEN");

    const foreign = await typeNamed(OTHER, "Cliente ausente");

    const crossTenant = await updateType(ADMIN, CARRIER, foreign.id, {
      code: "OUTRO",
    });

    expect(crossTenant.statusCode).toBe(404);
    expect(crossTenant.json().code).toBe("OCCURRENCE_TYPE_NOT_FOUND");
    expect((await typeNamed(OTHER, "Cliente ausente")).code).toBe("AUS-01");

    const cleared = await updateType(ADMIN, CARRIER, refused.id, {
      code: null,
    });

    expect(cleared.statusCode, cleared.body).toBe(200);
    expect((await typeNamed(CARRIER, "Recusou a carga")).code).toBeNull();
  });

  it("reaches the integrator as occurrence_code on the occurrence.reported event", async () => {
    const type = await typeNamed(CARRIER, "Cliente ausente");

    const delivery = await prisma.delivery.create({
      data: {
        recipient_name: "Mercado",
        city: "São Paulo",
        uf: "SP",
        street: "Rua",
        businessId: CARRIER,
        shipperId: SHIPPER,
        status: "IN_TRANSIT",
      },
    });

    const occurrence = await prisma.deliveryOccurrence.create({
      data: {
        deliveryId: delivery.id,
        businessId: CARRIER,
        occurrenceTypeId: type.id,
        reportedById: ADMIN,
      },
    });

    await prisma.deliveryEvent.create({
      data: {
        type: "OCCURRENCE",
        deliveryId: delivery.id,
        businessId: CARRIER,
        occurrenceId: occurrence.id,
      },
    });

    // A plain status change of the same delivery: no occurrence, no code.
    await prisma.deliveryEvent.create({
      data: {
        type: "STATUS_CHANGE",
        status_from: "PENDING",
        status_to: "IN_TRANSIT",
        deliveryId: delivery.id,
        businessId: CARRIER,
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/integration/v1/events",
      headers: { authorization: `Bearer ${eventsKey}` },
    });

    expect(response.statusCode, response.body).toBe(200);

    const events = response.json().data as Array<{
      topic: string;
      data: Record<string, unknown>;
    }>;

    const reported = events.find(
      (event) => event.topic === "occurrence.reported",
    );
    const moved = events.find((event) => event.topic === "delivery.in_transit");

    expect(reported?.data.occurrence_code).toBe("AUS-01");
    expect(moved?.data).toHaveProperty("occurrence_code", null);
  });
});
