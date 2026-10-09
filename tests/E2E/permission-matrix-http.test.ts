import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { sign } from "jsonwebtoken";
import auth from "@/config/auth";

/**
 * The permission and module matrix, through the real application.
 *
 * Contract §8 asks every surface to agree for MASTER, BUSINESS_ADMIN,
 * BUSINESS_USER (full and read-only), the driver and a company without the
 * module. Two things were wrong at this layer (decisions 4.1 and 4.3):
 *
 * - a permission refusal carried the code BAD_REQUEST, so the web could not
 *   tell it from MODULE_NOT_ENABLED and told a read-only user of a company
 *   that hired Entregas that the module was not hired;
 * - the MASTER passed the module gate untouched, read and wrote records of a
 *   company that never hired the module, and /admin never showed the
 *   "não contratado" state.
 *
 * Every refusal below is also checked against the database: a 403 that still
 * let the row change would not be a refusal.
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const RUN = randomUUID().slice(0, 8);

// A hired both modules, B only FLEET, C only DELIVERIES.
const A = "018fe7a0-0000-7000-8000-0000000000aa";
const B = "018fe7a0-0000-7000-8000-0000000000bb";
const C = "018fe7a0-0000-7000-8000-0000000000cc";

const MASTER = "018fe7a0-0000-7000-8000-000000000a01";
const ADMIN_A = "018fe7a0-0000-7000-8000-000000000a02";
const ADMIN_B = "018fe7a0-0000-7000-8000-000000000a03";
const FULL_A = "018fe7a0-0000-7000-8000-000000000a04";
const READ_ONLY_A = "018fe7a0-0000-7000-8000-000000000a05";
const UNREADABLE_A = "018fe7a0-0000-7000-8000-000000000a06";
const DRIVER_USER_A = "018fe7a0-0000-7000-8000-000000000a07";

const DRIVER_A = "018fe7a0-0000-7000-8000-000000000d01";

const tokens: Record<string, string> = {};

let shipperKeptA = "";
let shipperDeletedA = "";
let shipperMasterA = "";
let shipperB = "";
let supplierC = "";

async function seedBusiness(
  id: string,
  modules: ("FLEET" | "DELIVERIES")[],
): Promise<void> {
  await prisma.business.create({
    data: {
      id,
      corporate_reason: `Matriz ${id.slice(-2)} ${RUN}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: `${Date.now()}${Math.floor(Math.random() * 10)}`.slice(-14),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `matriz-${id}-${RUN}@exemplo.com.br`,
    },
  });

  if (modules.length > 0) {
    await prisma.businessEntitlement.createMany({
      data: modules.map((module) => ({ businessId: id, module, enabled: true })),
    });
  }
}

async function seedProfile(
  name: string,
  permissions: Array<{ key: string; read: boolean; write: boolean }>,
): Promise<string> {
  const profile = await prisma.profileAccess.create({
    data: { name: `${name} ${RUN}`, businessId: A },
  });

  await prisma.permission.createMany({
    data: permissions.map((permission) => ({
      action: permission.key,
      permissionKey: permission.key,
      canRead: permission.read,
      canWrite: permission.write,
      profileAccessId: profile.id,
      businessId: A,
    })),
  });

  return profile.id;
}

async function mintToken(
  userId: string,
  role: "MASTER" | "BUSINESS_ADMIN" | "BUSINESS_USER",
  businessId: string | null,
  driverId: string | null = null,
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
      role,
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
  await seedBusiness(A, ["FLEET", "DELIVERIES"]);
  await seedBusiness(B, ["FLEET"]);
  await seedBusiness(C, ["DELIVERIES"]);

  await prisma.driver.create({
    data: {
      id: DRIVER_A,
      name: "Motorista Matriz",
      birth_date: new Date("1990-01-01"),
      cnh: `cnh-${RUN}`,
      cpf: `cpf-${RUN}`,
      rg: `rg-${RUN}`,
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

  const fullProfile = await seedProfile("Despacho completo", [
    { key: "delivery_manage", read: true, write: true },
    { key: "occurrence_manage", read: true, write: true },
  ]);

  const readOnlyProfile = await seedProfile("Entregas só leitura", [
    { key: "delivery_manage", read: true, write: false },
  ]);

  // The key is there, but not readable: what the bulk screen could store.
  const unreadableProfile = await seedProfile("Chave sem leitura", [
    { key: "delivery_manage", read: false, write: false },
    { key: "vehicle_manage", read: true, write: false },
  ]);

  const users = [
    { id: MASTER, role: "MASTER" as const, businessId: null },
    { id: ADMIN_A, role: "BUSINESS_ADMIN" as const, businessId: A },
    { id: ADMIN_B, role: "BUSINESS_ADMIN" as const, businessId: B },
    {
      id: FULL_A,
      role: "BUSINESS_USER" as const,
      businessId: A,
      profileAccessId: fullProfile,
    },
    {
      id: READ_ONLY_A,
      role: "BUSINESS_USER" as const,
      businessId: A,
      profileAccessId: readOnlyProfile,
    },
    {
      id: UNREADABLE_A,
      role: "BUSINESS_USER" as const,
      businessId: A,
      profileAccessId: unreadableProfile,
    },
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
        email: `matriz-${user.id}-${RUN}@exemplo.com.br`,
        password: "nao-usado",
      },
    });
  }

  tokens.master = await mintToken(MASTER, "MASTER", null);
  tokens.adminA = await mintToken(ADMIN_A, "BUSINESS_ADMIN", A);
  tokens.adminB = await mintToken(ADMIN_B, "BUSINESS_ADMIN", B);
  tokens.full = await mintToken(FULL_A, "BUSINESS_USER", A);
  tokens.readOnly = await mintToken(READ_ONLY_A, "BUSINESS_USER", A);
  tokens.unreadable = await mintToken(UNREADABLE_A, "BUSINESS_USER", A);
  tokens.driver = await mintToken(DRIVER_USER_A, "BUSINESS_USER", A, DRIVER_A);

  const shipper = (businessId: string, name: string) =>
    prisma.shipper.create({ data: { businessId, name: `${name} ${RUN}` } });

  shipperKeptA = (await shipper(A, "Embarcador mantido")).id;
  shipperDeletedA = (await shipper(A, "Embarcador removido")).id;
  shipperMasterA = (await shipper(A, "Embarcador do master")).id;
  shipperB = (await shipper(B, "Embarcador sem módulo")).id;

  supplierC = (
    await prisma.supplier.create({
      data: { businessId: C, name: `Fornecedor ${RUN}`, cnpj: "11222333000181" },
    })
  ).id;

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  const companies = [A, B, C];

  await prisma.shipper.deleteMany({ where: { businessId: { in: companies } } });
  await prisma.supplier.deleteMany({ where: { businessId: { in: companies } } });

  const everyone = [
    MASTER,
    ADMIN_A,
    ADMIN_B,
    FULL_A,
    READ_ONLY_A,
    UNREADABLE_A,
    DRIVER_USER_A,
  ];

  await prisma.refreshToken.deleteMany({ where: { userId: { in: everyone } } });
  await prisma.activity.deleteMany({
    where: {
      OR: [{ businessId: { in: companies } }, { performedBy: { in: everyone } }],
    },
  });
  await prisma.user.deleteMany({ where: { id: { in: everyone } } });

  await prisma.permission.deleteMany({ where: { businessId: A } });
  await prisma.profileAccess.deleteMany({ where: { businessId: A } });
  await prisma.driver.deleteMany({ where: { id: DRIVER_A } });

  await prisma.businessEntitlement.deleteMany({
    where: { businessId: { in: companies } },
  });
  await prisma.business.deleteMany({ where: { id: { in: companies } } });

  await app?.close();
  await prisma.$disconnect();
}, 60_000);

const call = (method: "GET" | "DELETE", url: string, token: string) =>
  app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
  });

const listDeliveries = (businessId: string) =>
  `/delivery/list-delivery?businessId=${businessId}&page=1&pageSize=5`;

const listOccurrenceTypes = (businessId: string) =>
  `/occurrence-type/list-occurrence-type?businessId=${businessId}&page=1&pageSize=5`;

const deleteShipper = (shipperId: string, businessId: string) =>
  `/shipper/delete-shipper/${shipperId}/business/${businessId}`;

async function shipperExists(id: string): Promise<boolean> {
  return (await prisma.shipper.count({ where: { id } })) === 1;
}

describe("BUSINESS_USER with Entregas read-only", () => {
  it("reads the deliveries", async () => {
    const response = await call("GET", listDeliveries(A), tokens.readOnly);

    expect(response.statusCode).toBe(200);
  });

  it("is refused a section of another key with PERMISSION_DENIED, not a module code", async () => {
    // This is the tab that showed "Módulo Entregas não contratado".
    const response = await call("GET", listOccurrenceTypes(A), tokens.readOnly);

    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("PERMISSION_DENIED");
  });

  it("is refused a write with PERMISSION_DENIED and nothing changes", async () => {
    const response = await call(
      "DELETE",
      deleteShipper(shipperKeptA, A),
      tokens.readOnly,
    );

    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("PERMISSION_DENIED");
    expect(await shipperExists(shipperKeptA)).toBe(true);
  });
});

describe("BUSINESS_USER with the full profile", () => {
  it("reads both sections", async () => {
    expect((await call("GET", listDeliveries(A), tokens.full)).statusCode).toBe(200);
    expect(
      (await call("GET", listOccurrenceTypes(A), tokens.full)).statusCode,
    ).toBe(200);
  });

  it("writes (control: the refusals above are the gate, not a broken route)", async () => {
    const response = await call(
      "DELETE",
      deleteShipper(shipperDeletedA, A),
      tokens.full,
    );

    expect(response.statusCode).toBe(200);
    expect(await shipperExists(shipperDeletedA)).toBe(false);
  });
});

describe("a profile row that exists but is not readable", () => {
  it("is refused the read", async () => {
    const response = await call("GET", listDeliveries(A), tokens.unreadable);

    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("PERMISSION_DENIED");
  });
});

describe("the driver", () => {
  it("reads the day", async () => {
    expect((await call("GET", listDeliveries(A), tokens.driver)).statusCode).toBe(200);
  });

  it("is refused the company's occurrence catalogue with PERMISSION_DENIED", async () => {
    const response = await call("GET", listOccurrenceTypes(A), tokens.driver);

    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("PERMISSION_DENIED");
  });

  it("is refused a dispatcher write and nothing changes", async () => {
    const response = await call(
      "DELETE",
      deleteShipper(shipperKeptA, A),
      tokens.driver,
    );

    expect(response.statusCode).toBe(403);
    expect(await shipperExists(shipperKeptA)).toBe(true);
  });
});

describe("a company without the module", () => {
  it("answers its administrator MODULE_NOT_ENABLED", async () => {
    const response = await call("GET", listDeliveries(B), tokens.adminB);

    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("MODULE_NOT_ENABLED");
  });

  it("keeps the tenant refusal ahead of the module one", async () => {
    // A foreign company is a tenant question before it is a plan question.
    const response = await call("GET", listDeliveries(B), tokens.adminA);

    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("TENANT_ACCESS_DENIED");
  });
});

describe("MASTER is module-gated on the company it names (decision 4.3)", () => {
  it("reads a company that hired the module", async () => {
    expect((await call("GET", listDeliveries(A), tokens.master)).statusCode).toBe(
      200,
    );
  });

  it("is refused the reads of a company that did not", async () => {
    const response = await call("GET", listDeliveries(B), tokens.master);

    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("MODULE_NOT_ENABLED");
    expect(response.json().message).toMatch(/Módulos Contratados/);
  });

  it("is refused a write into that company and nothing changes", async () => {
    const response = await call(
      "DELETE",
      deleteShipper(shipperB, B),
      tokens.master,
    );

    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("MODULE_NOT_ENABLED");
    expect(await shipperExists(shipperB)).toBe(true);
  });

  it("is refused a fleet write into a company without FLEET", async () => {
    const response = await call(
      "DELETE",
      `/supplier/delete-supplier/${supplierC}/business/${C}`,
      tokens.master,
    );

    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("MODULE_NOT_ENABLED");
    expect(await prisma.supplier.count({ where: { id: supplierC } })).toBe(1);
  });

  it("still writes into a company that hired it (control)", async () => {
    const response = await call(
      "DELETE",
      deleteShipper(shipperMasterA, A),
      tokens.master,
    );

    expect(response.statusCode).toBe(200);
    expect(await shipperExists(shipperMasterA)).toBe(false);
  });
});
