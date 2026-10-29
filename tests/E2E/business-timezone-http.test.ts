import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { sign } from "jsonwebtoken";

import { randomUUID } from "node:crypto";

import auth from "@/config/auth";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * The company's time zone is editable by the MASTER (decision 1.1): only
 * Brazil's IANA zones are accepted, it is saved on the company and never
 * pushed onto the head-office branch (which has no such column), and a
 * company admin cannot change it. Conflicts answer 409 with a code.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const tokens: Record<"master" | "admin", string> = {} as never;

let seq = 0;

function businessBody(overrides: Record<string, unknown> = {}) {
  seq += 1;

  return {
    corporate_reason: `Transportadora Fuso ${seq}`,
    cep: "01001000",
    city: "Cuiabá",
    uf: "MT",
    street: "Rua",
    address_number: "1",
    cnpj: String(85222555000100 + seq),
    cnae: "4930202",
    responsible_name: "Carla Souza",
    telephone: "65999999999",
    email: `fuso${seq}-${randomUUID().slice(0, 6)}@exemplo.com.br`,
    ...overrides,
  };
}

async function seedUser(
  role: "MASTER" | "BUSINESS_ADMIN",
  businessId: string | null,
): Promise<string> {
  const id = randomUUID();
  const familyId = randomUUID();

  await prisma.user.create({
    data: {
      id,
      name: `Usuário ${id.slice(0, 4)}`,
      email: `${id}@exemplo.com.br`,
      password: "not-used-here",
      role,
      businessId,
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
    { subject: id, expiresIn: "15m" },
  );
}

async function createBusiness(
  body: Record<string, unknown>,
  token = tokens.master,
) {
  return app.inject({
    method: "POST",
    url: "/business/create-business",
    headers: { authorization: `Bearer ${token}` },
    payload: body,
  });
}

async function updateBusiness(
  id: string,
  body: Record<string, unknown>,
  token = tokens.master,
) {
  return app.inject({
    method: "PATCH",
    url: `/business/update-business/${id}`,
    headers: { authorization: `Bearer ${token}` },
    payload: body,
  });
}

beforeAll(async () => {
  tokens.master = await seedUser("MASTER", null);

  ({ app } = await import("@/http"));
  await app.ready();
}, 90_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

describe("Business.timezone", () => {
  it("is saved on create, defaults to São Paulo, and refuses a zone outside Brazil", async () => {
    const withZone = businessBody({ timezone: "America/Cuiaba" });
    expect((await createBusiness(withZone)).statusCode).toBe(201);

    const saved = await prisma.business.findUniqueOrThrow({
      where: { cnpj: withZone.cnpj as string },
    });
    expect(saved.timezone).toBe("America/Cuiaba");

    // The head office mirrors the company, without the zone.
    expect(
      await prisma.branch.count({ where: { cnpj: withZone.cnpj as string } }),
    ).toBe(1);

    const withoutZone = businessBody();
    expect((await createBusiness(withoutZone)).statusCode).toBe(201);
    expect(
      (
        await prisma.business.findUniqueOrThrow({
          where: { cnpj: withoutZone.cnpj as string },
        })
      ).timezone,
    ).toBe("America/Sao_Paulo");

    const lisbon = await createBusiness(
      businessBody({ timezone: "Europe/Lisbon" }),
    );
    expect(lisbon.statusCode).toBe(400);
    expect(lisbon.body).toContain("Fuso horário inválido");
  });

  it("is updated by the MASTER without touching the head office, and never by a company admin", async () => {
    const body = businessBody();
    await createBusiness(body);

    const business = await prisma.business.findUniqueOrThrow({
      where: { cnpj: body.cnpj as string },
    });

    const moved = await updateBusiness(business.id, {
      timezone: "America/Manaus",
      city: "Manaus",
      uf: "AM",
    });

    expect(moved.statusCode).toBe(200);
    expect(
      await prisma.business.findUniqueOrThrow({ where: { id: business.id } }),
    ).toMatchObject({
      timezone: "America/Manaus",
      city: "Manaus",
    });
    expect(
      await prisma.branch.findFirstOrThrow({
        where: { businessId: business.id },
      }),
    ).toMatchObject({ city: "Manaus", uf: "AM" });

    expect(
      (await updateBusiness(business.id, { timezone: "UTC" })).statusCode,
    ).toBe(400);

    tokens.admin = await seedUser("BUSINESS_ADMIN", business.id);

    expect(
      (
        await updateBusiness(
          business.id,
          { timezone: "America/Sao_Paulo" },
          tokens.admin,
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (await prisma.business.findUniqueOrThrow({ where: { id: business.id } }))
        .timezone,
    ).toBe("America/Manaus");
  });

  it("answers a duplicate with 409 and its code", async () => {
    const body = businessBody();
    await createBusiness(body);

    const again = await createBusiness(businessBody({ cnpj: body.cnpj }));

    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe("BUSINESS_CNPJ_TAKEN");
  });
});
