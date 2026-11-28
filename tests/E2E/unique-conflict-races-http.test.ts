import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { randomUUID } from "node:crypto";

import { sign } from "jsonwebtoken";
import { container } from "tsyringe";

import auth from "@/config/auth";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * Two requests for the same unique value at once, over real HTTP and a real
 * Postgres (batch of 14/11/2026). Both pass the use case's lookup before
 * either writes; the loser meets the unique index. Its catch did not map the
 * P2002, so it answered "Houve um erro… tente novamente" (500) for what is
 * the lookup's own 409. Whichever request loses — at the lookup or at the
 * index — the pair is one 201 and one 409 with the domain's code.
 */
vi.mock("@/websocket", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/websocket")>();

  return {
    ...actual,
    sendCatalogChangedEvent: () => undefined,
    sendSecurityEventToUser: () => undefined,
    sendSecurityEventToBusiness: () => undefined,
    refreshDeliveryRooms: async () => undefined,
  };
});

const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const A = randomUUID();

let adminToken = "";

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: A,
      corporate_reason: `Transportadora ${A}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(54000000000100 + Math.floor(Math.random() * 1_000_000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `${A}@exemplo.com.br`,
      vehicle_limit: 10,
    },
  });

  const adminId = randomUUID();
  const familyId = randomUUID();

  await prisma.user.create({
    data: {
      id: adminId,
      name: "Gestora Principal",
      email: `${adminId}@exemplo.com.br`,
      password: "not-used-here",
      role: "BUSINESS_ADMIN",
      businessId: A,
    },
  });
  await prisma.refreshToken.create({
    data: {
      userId: adminId,
      token_hash: randomUUID(),
      jti: randomUUID(),
      family_id: familyId,
      expires_in: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

  adminToken = sign(
    { tokenType: "access", sessionVersion: 0, familyId },
    auth.secret_token,
    { subject: adminId, expiresIn: "30m" },
  );

  ({ app } = await import("@/http"));
  await app.ready();

  // No real mail leaves a test.
  container.registerInstance("MailProvider", {
    sendMail: async () => ({ messageId: `<${randomUUID()}@x>` }),
  });
}, 120_000);

afterAll(async () => {
  await app?.close();
  await prisma.business.deleteMany({ where: { id: A } });
  await prisma.$disconnect();
});

const post = (url: string, payload: Record<string, unknown>) =>
  app.inject({
    method: "POST",
    url,
    headers: { authorization: `Bearer ${adminToken}` },
    payload,
  });

/** The two answers, the success first. */
function sorted(
  responses: Array<{ statusCode: number; body: string }>,
): Array<{ status: number; code?: string }> {
  return responses
    .map((response) => ({
      status: response.statusCode,
      code:
        response.statusCode >= 400 ? JSON.parse(response.body).code : undefined,
    }))
    .sort((a, b) => a.status - b.status);
}

describe("two creations of the same value at once", () => {
  it("users with the same e-mail: one 201 and one 409 USER_ALREADY_EXISTS, never a 500", async () => {
    const profile = await prisma.profileAccess.create({
      data: { name: `Operação ${randomUUID().slice(0, 8)}`, businessId: A },
    });
    const email = `corrida-${randomUUID()}@exemplo.com.br`;
    const body = (name: string) => ({
      name,
      email,
      role: "BUSINESS_USER",
      businessId: A,
      profileAccessId: profile.id,
      userType: "employee",
    });

    const answers = await Promise.all([
      post("/user/create-user", body("Maria Primeira")),
      post("/user/create-user", body("Maria Segunda")),
    ]);

    expect(sorted(answers), answers.map((a) => a.body).join(" | ")).toEqual([
      { status: 201, code: undefined },
      { status: 409, code: "USER_ALREADY_EXISTS" },
    ]);
    expect(await prisma.user.count({ where: { email } })).toBe(1);
  });

  it("access profiles with the same name: one 201 and one 409 PROFILE_ACCESS_ALREADY_EXISTS", async () => {
    const name = `Perfil Corrida ${randomUUID().slice(0, 8)}`;

    const answers = await Promise.all([
      post("/profile-access/create-profile-access", { name, businessId: A }),
      post("/profile-access/create-profile-access", { name, businessId: A }),
    ]);

    expect(sorted(answers), answers.map((a) => a.body).join(" | ")).toEqual([
      { status: 201, code: undefined },
      { status: 409, code: "PROFILE_ACCESS_ALREADY_EXISTS" },
    ]);
    expect(
      await prisma.profileAccess.count({ where: { name, businessId: A } }),
    ).toBe(1);
  });
});
