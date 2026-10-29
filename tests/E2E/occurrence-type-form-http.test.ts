import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { sign } from "jsonwebtoken";

import { randomUUID } from "node:crypto";

import auth from "@/config/auth";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * The occurrence type's form and authorization flag through the catalogue's
 * own routes (decisions 6.2 and 6.3): the definition is validated whole,
 * stored in one shape, and form_version moves only when the form changes —
 * the number a driver's answer is filed under.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018feb00-0000-7000-8000-00000000000a";
const OTHER = "018feb00-0000-7000-8000-00000000000b";

let adminToken = "";
let otherAdminToken = "";
let driverToken = "";

let cnpjSeq = 0;

async function seedBusiness(id: string): Promise<void> {
  cnpjSeq += 1;

  await prisma.business.create({
    data: {
      id,
      corporate_reason: `Transportadora ${id.slice(-1)}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(61222555000180 + cnpjSeq),
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

async function tokenFor(
  role: "BUSINESS_ADMIN" | "BUSINESS_USER",
  businessId: string,
  driverId?: string,
): Promise<string> {
  const id = randomUUID();
  const familyId = randomUUID();

  await prisma.user.create({
    data: {
      id,
      name: "Pessoa",
      email: `${id}@exemplo.com.br`,
      password: "not-used-here",
      role,
      businessId,
      driverId: driverId ?? null,
    },
  });

  await prisma.refreshToken.create({
    data: {
      userId: id,
      token_hash: randomUUID(),
      jti: randomUUID(),
      family_id: familyId,
      expires_in: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

  return sign(
    { tokenType: "access", sessionVersion: 0, familyId },
    auth.secret_token,
    {
      subject: id,
      expiresIn: "15m",
    },
  );
}

const FORM = [
  { key: "quem_atendeu", label: "Quem atendeu", type: "text", required: true },
  {
    key: "motivo",
    label: "Motivo",
    type: "select",
    required: true,
    options: ["Ausente", "Recusa"],
  },
];

async function send(
  method: "POST" | "PATCH",
  url: string,
  payload: Record<string, unknown>,
  token = adminToken,
) {
  const response = await app.inject({
    method,
    url,
    payload,
    headers: { authorization: `Bearer ${token}` },
  });

  return { status: response.statusCode, body: response.json() };
}

const typeNamed = (name: string) =>
  prisma.occurrenceType.findFirstOrThrow({
    where: { businessId: CARRIER, name },
  });

beforeAll(async () => {
  await seedBusiness(CARRIER);
  await seedBusiness(OTHER);

  const driver = await prisma.driver.create({
    data: {
      name: "Motorista",
      birth_date: new Date("1990-01-01"),
      cnh: "cnh-form-1",
      cpf: "cpf-form-1",
      rg: "rg-form-1",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId: CARRIER,
    },
  });

  adminToken = await tokenFor("BUSINESS_ADMIN", CARRIER);
  otherAdminToken = await tokenFor("BUSINESS_ADMIN", OTHER);
  driverToken = await tokenFor("BUSINESS_USER", CARRIER, driver.id);

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

describe("creating a type with a form", () => {
  it("stores the form normalized, version 1, and the authorization flag", async () => {
    const answer = await send(
      "POST",
      `/occurrence-type/create-occurrence-type/${CARRIER}`,
      {
        name: "Cliente ausente",
        blocks_delivery: true,
        requires_authorization: true,
        form_fields: FORM,
      },
    );

    expect(answer.status).toBe(201);

    const type = await typeNamed("Cliente ausente");

    expect(type).toMatchObject({
      requires_authorization: true,
      form_version: 1,
    });
    expect(type.form_fields).toEqual([
      {
        key: "quem_atendeu",
        label: "Quem atendeu",
        type: "text",
        required: true,
        max_length: 200,
        multiline: false,
      },
      {
        key: "motivo",
        label: "Motivo",
        type: "select",
        required: true,
        options: ["Ausente", "Recusa"],
      },
    ]);
  });

  it("refuses a definition that does not hold, saying why", async () => {
    const answer = await send(
      "POST",
      `/occurrence-type/create-occurrence-type/${CARRIER}`,
      {
        name: "Forma ruim",
        form_fields: [
          { key: "a", label: "A", type: "select", options: ["Só"] },
          { key: "a", label: "B", type: "text" },
        ],
      },
    );

    expect(answer.status).toBe(400);
    expect(answer.body.code).toBe("VALIDATION_ERROR");
    expect(answer.body.issues).toEqual(
      expect.arrayContaining([
        "A lista precisa de pelo menos 2 opções.",
        'A chave "a" aparece em mais de um campo.',
      ]),
    );
    expect(
      await prisma.occurrenceType.count({ where: { name: "Forma ruim" } }),
    ).toBe(0);
  });

  it("stores no form as NULL, not as an empty array", async () => {
    await send("POST", `/occurrence-type/create-occurrence-type/${CARRIER}`, {
      name: "Sem formulário",
      form_fields: [],
    });

    const [row] = await prisma.$queryRaw<Array<{ is_null: boolean }>>`
      SELECT form_fields IS NULL AS is_null FROM occurrence_type
      WHERE "businessId" = ${CARRIER} AND name = 'Sem formulário'
    `;

    expect(row.is_null).toBe(true);
  });
});

describe("editing the form", () => {
  it("moves form_version only when the form changes", async () => {
    const type = await typeNamed("Cliente ausente");
    const url = `/occurrence-type/update-occurrence-type/${type.id}/business/${CARRIER}`;

    // The dialog sends the form back on every save.
    const same = await send("PATCH", url, {
      name: "Cliente ausente",
      form_fields: FORM,
    });

    expect(same.status).toBe(200);
    expect((await typeNamed("Cliente ausente")).form_version).toBe(1);

    const changed = await send("PATCH", url, {
      form_fields: [
        ...FORM,
        { key: "protocolo", label: "Protocolo", type: "text", required: false },
      ],
    });

    expect(changed.status).toBe(200);
    expect((await typeNamed("Cliente ausente")).form_version).toBe(2);

    const cleared = await send("PATCH", url, {
      form_fields: null,
      requires_authorization: false,
    });

    expect(cleared.status).toBe(200);

    const after = await typeNamed("Cliente ausente");

    expect(after).toMatchObject({
      form_fields: null,
      form_version: 3,
      requires_authorization: false,
    });

    // Unrelated edits leave the version alone.
    await send("PATCH", url, { description: "Ninguém atendeu" });

    expect((await typeNamed("Cliente ausente")).form_version).toBe(3);
  });

  it("is the company's dispatcher's: another company reads it as missing, a driver is refused", async () => {
    const type = await typeNamed("Cliente ausente");

    const foreign = await send(
      "PATCH",
      `/occurrence-type/update-occurrence-type/${type.id}/business/${OTHER}`,
      { form_fields: FORM },
      otherAdminToken,
    );

    expect(foreign).toMatchObject({
      status: 404,
      body: { code: "OCCURRENCE_TYPE_NOT_FOUND" },
    });

    const driver = await send(
      "PATCH",
      `/occurrence-type/update-occurrence-type/${type.id}/business/${CARRIER}`,
      { form_fields: FORM },
      driverToken,
    );

    expect(driver.status).toBe(403);
    expect((await typeNamed("Cliente ausente")).form_version).toBe(3);
  });
});

describe("the catalogue listing", () => {
  it("carries the form and the flag to the panel", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/occurrence-type/list-occurrence-type?businessId=${CARRIER}&page=1&pageSize=20&search=Sem`,
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(response.statusCode).toBe(200);

    const [, ...rows] = response.body
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(rows[0]).toMatchObject({
      name: "Sem formulário",
      form_fields: null,
      form_version: 1,
      requires_authorization: false,
    });
  });
});
