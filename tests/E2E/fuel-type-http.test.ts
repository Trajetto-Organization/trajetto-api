import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { sign } from "jsonwebtoken";

import { randomUUID } from "node:crypto";

import auth from "@/config/auth";

/**
 * The fuel types catalog over real HTTP and Postgres.
 *
 * - The list is one company's (the MASTER names it; he used to get every
 *   company's catalog mixed in one table), ordered by the server.
 * - An edit never moves a fuel type to another company. The lookup read a
 *   businessId the schema had stripped, matched the id alone, and the
 *   MASTER's edit form re-parented the type — with its vehicles and
 *   refuelings — to whatever company was picked.
 * - Another company's id is a 404, never a 403 that confirms it exists.
 * - A fuel type in use is not deleted (409 with the count).
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018fe400-0000-7000-8000-00000000000a";
const OTHER = "018fe400-0000-7000-8000-00000000000b";

const DIESEL = "018fe400-0000-7000-8000-0000000000e1";
const GASOLINA = "018fe400-0000-7000-8000-0000000000e2";
const ETANOL = "018fe400-0000-7000-8000-0000000000e3";
const OTHER_GNV = "018fe400-0000-7000-8000-0000000000e9";

const tokens: Record<
  "admin" | "readOnly" | "noKey" | "driver" | "otherAdmin" | "master",
  string
> = {} as never;

let cnpjSeq = 0;

async function seedBusiness(id: string) {
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
      cnpj: String(81222555000180 + cnpjSeq),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `${id}@exemplo.com.br`,
    },
  });
}

async function seedProfile(businessId: string, key: string, canWrite: boolean) {
  const profile = await prisma.profileAccess.create({
    data: {
      name: `Perfil ${randomUUID().slice(0, 8)}`,
      businessId,
      permissions: {
        create: [
          { permissionKey: key, action: key, canRead: true, canWrite, businessId },
        ],
      },
    },
  });

  return profile.id;
}

async function seedUser(
  role: "MASTER" | "BUSINESS_ADMIN" | "BUSINESS_USER",
  businessId: string | null,
  extra: { profileAccessId?: string; driverId?: string } = {},
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
      profileAccessId: extra.profileAccessId ?? null,
      driverId: extra.driverId ?? null,
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

async function list(query: string, token = tokens.admin) {
  const response = await app.inject({
    method: "GET",
    url: `/fuel-type/list-fuel-type?page=1&pageSize=10${query ? `&${query}` : ""}`,
    headers: { authorization: `Bearer ${token}` },
  });

  if (response.statusCode !== 200) {
    return { status: response.statusCode, rows: [] as any[], total: 0, body: response.body };
  }

  const [first, ...rows] = response.body
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  return { status: 200, rows, total: first.meta.total as number, body: response.body };
}

beforeAll(async () => {
  await seedBusiness(CARRIER);
  await seedBusiness(OTHER);

  const now = Date.now();

  await prisma.fuelType.createMany({
    data: [
      { id: DIESEL, description: "Diesel", businessId: CARRIER, created_at: new Date(now - 3_000) },
      { id: GASOLINA, description: "Gasolina", businessId: CARRIER, created_at: new Date(now - 2_000) },
      { id: ETANOL, description: "Etanol", businessId: CARRIER, created_at: new Date(now - 1_000) },
      { id: OTHER_GNV, description: "GNV", businessId: OTHER },
    ],
  });

  // Diesel is in use: one vehicle runs on it.
  await prisma.vehicle.create({
    data: {
      license_plate: "DSL1A11",
      description: "Caminhão a diesel",
      brand: "Marca",
      model: "Modelo",
      acquisition_date: new Date("2020-01-01"),
      fleet_type: "OWNED",
      current_mileage: 1_000,
      maintenance_interval_km: 10_000,
      maintenance_interval_months: 6,
      renavam: "12345678901",
      manufacturing_year: new Date("2019-01-01"),
      model_year: new Date("2020-01-01"),
      km_per_liter: 3,
      number_of_axles: 2,
      status: "ACTIVE",
      businessId: CARRIER,
      fuelTypeId: DIESEL,
    },
  });

  const driver = await prisma.driver.create({
    data: {
      name: "Motorista",
      birth_date: new Date("1990-01-01"),
      cnh: "ft-cnh-1",
      cpf: "ft-cpf-1",
      rg: "ft-rg-1",
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

  tokens.admin = await seedUser("BUSINESS_ADMIN", CARRIER);
  tokens.readOnly = await seedUser("BUSINESS_USER", CARRIER, {
    profileAccessId: await seedProfile(CARRIER, "fuel_type_manage", false),
  });
  tokens.noKey = await seedUser("BUSINESS_USER", CARRIER, {
    profileAccessId: await seedProfile(CARRIER, "fuel_manage", true),
  });
  tokens.driver = await seedUser("BUSINESS_USER", CARRIER, { driverId: driver.id });
  tokens.otherAdmin = await seedUser("BUSINESS_ADMIN", OTHER);
  tokens.master = await seedUser("MASTER", null);

  ({ app } = await import("@/http"));
  await app.ready();
}, 90_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

describe("GET /fuel-type/list-fuel-type", () => {
  it("lists one company, newest first, and orders by the server", async () => {
    const newest = await list("");

    expect(newest.status).toBe(200);
    expect(newest.total).toBe(3);
    expect(newest.rows.map((row) => row.id)).toEqual([ETANOL, GASOLINA, DIESEL]);

    const byName = await list("sort=description&order=asc");

    expect(byName.rows.map((row) => row.description)).toEqual([
      "Diesel",
      "Etanol",
      "Gasolina",
    ]);
    expect(byName.body).not.toContain("GNV");
  });

  it("makes the MASTER name the company and refuses another company's manager", async () => {
    const without = await list("", tokens.master);

    expect(without.status).toBe(400);
    expect(without.body).toContain("BUSINESS_NOT_IDENTIFIED");

    const other = await list(`businessId=${OTHER}`, tokens.master);

    expect(other.rows.map((row) => row.id)).toEqual([OTHER_GNV]);

    expect((await list(`businessId=${CARRIER}`, tokens.otherAdmin)).status).toBe(403);
  });

  it("lets a read-only profile read and refuses a profile or a driver without the key", async () => {
    expect((await list("", tokens.readOnly)).status).toBe(200);
    expect((await list("", tokens.noKey)).status).toBe(403);
    expect((await list("", tokens.driver)).status).toBe(403);
  });

  it("refuses an order the server does not offer", async () => {
    expect((await list("sort=businessId")).status).toBe(400);
  });
});

describe("GET /fuel-type/search-fuel-type-business — the picker", () => {
  it("filters by the typed term on the server", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/fuel-type/search-fuel-type-business?businessId=${CARRIER}&search=gaso`,
      headers: { authorization: `Bearer ${tokens.admin}` },
    });

    const [, ...rows] = response.body.trim().split("\n").map((line) => JSON.parse(line));

    expect(rows.map((row) => row.id)).toEqual([GASOLINA]);
  });

  it("answers a company that does not exist with 404 BUSINESS_NOT_FOUND and the code", async () => {
    // Red before: `400 { message }` with no code, while the fuel writes
    // answered the same BusinessNotFoundError as 404 BUSINESS_NOT_FOUND.
    const response = await app.inject({
      method: "GET",
      url: `/fuel-type/search-fuel-type-business?businessId=${randomUUID()}`,
      headers: { authorization: `Bearer ${tokens.master}` },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe("BUSINESS_NOT_FOUND");
    expect(response.headers["x-error-code"]).toBe("BUSINESS_NOT_FOUND");
  });
});

describe("POST /fuel-type/create-fuel-type", () => {
  const create = (businessId: string, token: string, description = "GLP") =>
    app.inject({
      method: "POST",
      url: `/fuel-type/create-fuel-type/${businessId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { description },
    });

  it("refuses another company's manager and a read-only profile", async () => {
    expect((await create(CARRIER, tokens.otherAdmin)).statusCode).toBe(403);
    expect((await create(CARRIER, tokens.readOnly)).statusCode).toBe(403);
    expect(await prisma.fuelType.count({ where: { description: "GLP" } })).toBe(0);
  });

  it("answers a duplicate in the company with 409 and creates a new one", async () => {
    const duplicate = await create(CARRIER, tokens.admin, "Diesel");

    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().code).toBe("FUEL_TYPE_ALREADY_EXISTS");
    expect(duplicate.headers["x-error-code"]).toBe("FUEL_TYPE_ALREADY_EXISTS");

    expect((await create(CARRIER, tokens.admin, "Hidrogênio")).statusCode).toBe(201);
  });
});

describe("PATCH /fuel-type/update-fuel-type", () => {
  it("never moves a fuel type to another company, not even for the MASTER", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: `/fuel-type/update-fuel-type/${ETANOL}/business/${OTHER}`,
      headers: { authorization: `Bearer ${tokens.master}` },
      payload: { description: "Biodiesel" },
    });

    expect(response.statusCode).toBe(404);

    const stored = await prisma.fuelType.findUniqueOrThrow({ where: { id: ETANOL } });

    expect(stored.businessId).toBe(CARRIER);
    expect(stored.description).toBe("Etanol");
  });

  it("answers another company's id with 404, not a 403 that confirms it", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: `/fuel-type/update-fuel-type/${OTHER_GNV}/business/${CARRIER}`,
      headers: { authorization: `Bearer ${tokens.admin}` },
      payload: { description: "Biodiesel" },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe("FUEL_TYPE_NOT_FOUND");
  });

  it("refuses a name the company already uses with 409", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: `/fuel-type/update-fuel-type/${ETANOL}/business/${CARRIER}`,
      headers: { authorization: `Bearer ${tokens.admin}` },
      payload: { description: "Diesel" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("FUEL_TYPE_ALREADY_EXISTS");
  });

  it("renames inside the company", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: `/fuel-type/update-fuel-type/${ETANOL}/business/${CARRIER}`,
      headers: { authorization: `Bearer ${tokens.admin}` },
      payload: { description: "Biodiesel" },
    });

    expect(response.statusCode).toBe(200);

    const stored = await prisma.fuelType.findUniqueOrThrow({ where: { id: ETANOL } });

    expect(stored.description).toBe("Biodiesel");
    expect(stored.businessId).toBe(CARRIER);
  });

  it("refuses a read-only profile", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: `/fuel-type/update-fuel-type/${GASOLINA}/business/${CARRIER}`,
      headers: { authorization: `Bearer ${tokens.readOnly}` },
      payload: { description: "GLP" },
    });

    expect(response.statusCode).toBe(403);
  });
});

describe("DELETE /fuel-type/delete-fuel-type", () => {
  const remove = (fuelTypeId: string, businessId = CARRIER, token = tokens.admin) =>
    app.inject({
      method: "DELETE",
      url: `/fuel-type/delete-fuel-type/${fuelTypeId}/business/${businessId}`,
      headers: { authorization: `Bearer ${token}` },
    });

  it("refuses a fuel type in use with 409 and the count", async () => {
    const response = await remove(DIESEL);

    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("FUEL_TYPE_IN_USE");
    expect(response.headers["x-error-code"]).toBe("FUEL_TYPE_IN_USE");
    expect(response.json().message).toContain("1");
  });

  it("answers another company's fuel type with 404 and leaves it alone", async () => {
    const foreign = await remove(OTHER_GNV);
    const missing = await remove(randomUUID());

    expect(foreign.statusCode).toBe(404);
    expect(foreign.headers["x-error-code"]).toBe("FUEL_TYPE_NOT_FOUND");
    expect(foreign.json()).toEqual(missing.json());
    expect((await remove(OTHER_GNV, OTHER)).statusCode).toBe(403);

    expect(await prisma.fuelType.count({ where: { id: OTHER_GNV } })).toBe(1);
  });

  it("deletes one nobody uses", async () => {
    expect((await remove(GASOLINA)).statusCode).toBe(200);
    expect(await prisma.fuelType.count({ where: { id: GASOLINA } })).toBe(0);
  });
});
