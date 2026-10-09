import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { sign } from "jsonwebtoken";
import auth from "@/config/auth";

/**
 * The tenant guard reads EVERY businessId a request carries.
 *
 * It used to read one: `params ?? query ?? body`. The caller chose which by
 * choosing where to put it — `?businessId=<own>` was checked and approved,
 * while the use case read the body, which named another company. With that, a
 * BUSINESS_ADMIN of one carrier created an administrator inside another one,
 * with an e-mail of their own choosing, and the generated password was mailed
 * to them. An empty `?businessId=` or a repeated one skipped the check
 * outright.
 *
 * Every test here goes through the real application, the real hooks and the
 * real database, and asserts on what was WRITTEN — a 403 that still let the
 * row through would not be a refusal.
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const A = "018fc000-0000-7000-8000-0000000000fa";
const B = "018fc000-0000-7000-8000-0000000000fb";

const ADMIN_A = "018fc000-0000-7000-8000-0000000001a1";
const USER_A = "018fc000-0000-7000-8000-0000000001a2";
const DRIVER_USER_A = "018fc000-0000-7000-8000-0000000001a3";
const USER_B = "018fc000-0000-7000-8000-0000000001b1";

const DRIVER_A = "018fc000-0000-7000-8000-0000000001d1";

let adminToken = "";
let driverToken = "";

let columnA = "";
let columnB = "";
let cardB = "";
let branchA = "";

async function seedBusiness(
  id: string,
  cnpj: string,
  modules: ("FLEET" | "DELIVERIES")[],
): Promise<void> {
  await prisma.business.create({
    data: {
      id,
      corporate_reason: `Transportadora ${id.slice(-2)}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj,
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `prec-${id}-${randomUUID()}@exemplo.com.br`,
    },
  });

  await prisma.businessEntitlement.createMany({
    data: modules.map((module) => ({ businessId: id, module, enabled: true })),
  });
}

async function mintToken(
  userId: string,
  businessId: string,
  driverId: string | null,
): Promise<string> {
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
    {
      tokenType: "access",
      role: driverId ? "BUSINESS_USER" : "BUSINESS_ADMIN",
      businessId,
      driverId,
      sessionVersion: 0,
      familyId,
    },
    auth.secret_token,
    { subject: userId, expiresIn: "1h" },
  );
}

beforeAll(async () => {
  // A never hired DELIVERIES; B did. That difference is what the module-gate
  // case below needs.
  await seedBusiness(A, "55333999000101", ["FLEET"]);
  await seedBusiness(B, "55333999000102", ["FLEET", "DELIVERIES"]);

  await prisma.driver.create({
    data: {
      id: DRIVER_A,
      name: "Motorista A",
      birth_date: new Date("1990-01-01"),
      cnh: `cnh-${DRIVER_A.slice(-8)}`,
      cpf: `cpf-${DRIVER_A.slice(-8)}`,
      rg: `rg-${DRIVER_A.slice(-8)}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId: A,
    },
  });

  const users = [
    { id: ADMIN_A, role: "BUSINESS_ADMIN" as const, businessId: A },
    { id: USER_A, role: "BUSINESS_USER" as const, businessId: A },
    { id: USER_B, role: "BUSINESS_ADMIN" as const, businessId: B },
    {
      id: DRIVER_USER_A,
      role: "BUSINESS_USER" as const,
      businessId: A,
      driverId: DRIVER_A,
    },
  ];

  for (const user of users) {
    await prisma.user.create({
      data: {
        ...user,
        name: `Pessoa ${user.id.slice(-3)}`,
        email: `prec-${user.id}-${randomUUID()}@exemplo.com.br`,
        password: "nao-usado",
      },
    });
  }

  adminToken = await mintToken(ADMIN_A, A, null);
  driverToken = await mintToken(DRIVER_USER_A, A, DRIVER_A);

  const branch = await prisma.branch.create({
    data: {
      corporate_reason: `Filial A ${randomUUID().slice(0, 8)}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: `77${Math.floor(Math.random() * 1e12)}`.slice(0, 14),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `filial-a-${randomUUID()}@exemplo.com.br`,
      businessId: A,
    },
  });

  branchA = branch.id;

  const colA = await prisma.kanbanColumn.create({
    data: { title: "A fazer", color: "#000", position: 0, businessId: A },
  });

  const colB = await prisma.kanbanColumn.create({
    data: { title: "Sigiloso", color: "#000", position: 0, businessId: B },
  });

  columnA = colA.id;
  columnB = colB.id;

  const card = await prisma.kanbanCard.create({
    data: {
      title: "Contrato da B",
      description: "valor confidencial",
      priority: "HIGH",
      dueDate: new Date(),
      position: 0,
      columnId: columnB,
    },
  });

  cardB = card.id;

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await prisma.kanbanCard.deleteMany({
    where: { columnId: { in: [columnA, columnB] } },
  });
  await prisma.kanbanColumn.deleteMany({ where: { businessId: { in: [A, B] } } });

  await prisma.accountPayable.deleteMany({
    where: { businessId: { in: [A, B] } },
  });
  await prisma.branch.deleteMany({ where: { businessId: { in: [A, B] } } });

  const everyone = await prisma.user.findMany({
    where: { businessId: { in: [A, B] } },
    select: { id: true },
  });

  const ids = everyone.map((user) => user.id);

  await prisma.refreshToken.deleteMany({ where: { userId: { in: ids } } });
  await prisma.emailVerificationToken.deleteMany({
    where: { email: { startsWith: "colega-" } },
  });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });

  await prisma.driver.deleteMany({ where: { id: DRIVER_A } });
  await prisma.businessEntitlement.deleteMany({
    where: { businessId: { in: [A, B] } },
  });
  await prisma.business.deleteMany({ where: { id: { in: [A, B] } } });

  await app?.close();
  await prisma.$disconnect();
}, 60_000);

const call = (
  method: "GET" | "POST" | "PATCH",
  url: string,
  token: string,
  payload?: unknown,
) =>
  app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload ? { payload: payload as never } : {}),
  });

function intruderFor(label: string) {
  return {
    name: "Joao Invasor",
    email: `invasor-${label}-${randomUUID()}@exemplo.com.br`,
    role: "BUSINESS_ADMIN",
    businessId: B,
  };
}

async function adminsOfB(): Promise<number> {
  return prisma.user.count({
    where: { businessId: B, role: "BUSINESS_ADMIN", id: { not: USER_B } },
  });
}

describe("creating a user in another company", () => {
  it("control: the route works for the caller's own company", async () => {
    const response = await call("POST", "/user/create-user", adminToken, {
      name: "Maria Colega",
      email: `colega-${randomUUID()}@exemplo.com.br`,
      role: "BUSINESS_ADMIN",
      businessId: A,
    });

    // Without this, every refusal below could be the route being broken.
    expect(response.statusCode).toBe(201);
  });

  it("refuses ?businessId=<own> when the body names another company", async () => {
    const intruder = intruderFor("query-own");

    const response = await call(
      "POST",
      `/user/create-user?businessId=${A}`,
      adminToken,
      intruder,
    );

    expect(response.statusCode).toBe(403);
    expect(await prisma.user.count({ where: { email: intruder.email } })).toBe(0);
  });

  it("refuses an empty ?businessId= instead of skipping the check", async () => {
    const intruder = intruderFor("query-empty");

    const response = await call(
      "POST",
      "/user/create-user?businessId=",
      adminToken,
      intruder,
    );

    expect(response.statusCode).toBe(403);
    expect(await prisma.user.count({ where: { email: intruder.email } })).toBe(0);
  });

  it("refuses a repeated ?businessId= instead of skipping the check", async () => {
    const intruder = intruderFor("query-array");

    const response = await call(
      "POST",
      `/user/create-user?businessId=${A}&businessId=${B}`,
      adminToken,
      intruder,
    );

    expect(response.statusCode).toBe(403);
    expect(await prisma.user.count({ where: { email: intruder.email } })).toBe(0);
  });

  it("leaves company B with no administrator it did not create", async () => {
    expect(await adminsOfB()).toBe(0);
  });
});

describe("moving a user into another company", () => {
  it("refuses the same query trick on update-user", async () => {
    const response = await call(
      "PATCH",
      `/user/update-user/${USER_A}?businessId=${A}`,
      adminToken,
      { businessId: B, role: "BUSINESS_ADMIN" },
    );

    // The body schema refuses any businessId before the tenant guard runs
    // (decision 16.100): still refused, now as the request being wrong.
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).code).toBe("VALIDATION_ERROR");

    const user = await prisma.user.findUniqueOrThrow({ where: { id: USER_A } });
    expect(user.businessId).toBe(A);
    expect(user.role).toBe("BUSINESS_USER");
  });
});

describe("kanban reorder across companies", () => {
  it("refuses pulling another company's card onto the caller's board", async () => {
    const response = await call("POST", "/kanban/cards/reorder", adminToken, {
      cards: [{ id: cardB, columnId: columnA, position: 0 }],
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.statusCode).toBeLessThan(500);

    const card = await prisma.kanbanCard.findUniqueOrThrow({ where: { id: cardB } });
    expect(card.columnId).toBe(columnB);
  });
});

describe("account payable responsible user", () => {
  it("refuses a responsible user from another company", async () => {
    const response = await call(
      "POST",
      `/account-payable/create-account-payable/${A}`,
      adminToken,
      {
        category: "FUEL",
        due_date: "2026-12-31",
        amount: 150,
        branchId: branchA,
        registrationUserId: USER_B,
      },
    );

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.statusCode).toBeLessThan(500);
    expect(await prisma.accountPayable.count({ where: { businessId: A } })).toBe(0);
  });
});

describe("fleet exports by a driver", () => {
  it.each(["/fuel/export-fuel", "/vehicle-checklist/export-vehicle-checklist"])(
    "refuses %s for a driver token",
    async (url) => {
      const response = await call("GET", url, driverToken);

      // Decision 4.1: a permission refusal, from the route's guard.
      expect(response.statusCode).toBe(403);
      expect(response.json().code).toBe("PERMISSION_DENIED");
    },
  );
});

describe("module gate and tenant guard agree on the company", () => {
  const message = { driverIds: [DRIVER_A], kind: "TEXT", body: "oi" };

  it("control: a company without DELIVERIES is refused", async () => {
    const response = await call("POST", "/chat/send-message", adminToken, message);

    // The 403 response schema keeps only `message`, so the code is not on the
    // wire; the sentence is what tells the two refusals apart.
    expect(response.statusCode).toBe(403);
    expect(response.json().message).toMatch(/módulo não está habilitado/);
  });

  it("naming a company that hired the module in the body does not help", async () => {
    const response = await call(
      "POST",
      `/chat/send-message?businessId=${A}`,
      adminToken,
      { ...message, businessId: B },
    );

    expect(response.statusCode).toBe(403);
    expect(await prisma.chatMessage.count({ where: { body: "oi" } })).toBe(0);
  });
});
