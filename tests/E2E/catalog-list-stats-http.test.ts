import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { sign } from "jsonwebtoken";

import { randomUUID } from "node:crypto";

import auth from "@/config/auth";

/**
 * The cards above Perfis de acesso, Tipos de veículo and Tipos de combustível
 * over real HTTP and Postgres (decision 16.350): the `meta.searchMeta` line
 * of each listing counts the company's whole search — never the page, never
 * another company's rows, even when the MASTER asks — and the fuel month
 * appears only with Gestão de Frotas and a profile that reads refuelings.
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018fe900-0000-7000-8000-00000000000a";
const OTHER = "018fe900-0000-7000-8000-00000000000b";
const NO_FLEET = "018fe900-0000-7000-8000-00000000000c";

const tokens: Record<
  "admin" | "otherAdmin" | "noFleetAdmin" | "catalogOnly" | "master",
  string
> = {} as never;

let cnpjSeq = 0;

async function seedBusiness(
  id: string,
  modules: Array<"FLEET" | "DELIVERIES">,
) {
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
      cnpj: String(71222555000180 + cnpjSeq),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `${id}@exemplo.com.br`,
      entitlements: { create: modules.map((module) => ({ module })) },
    },
  });
}

async function seedUser(
  role: "MASTER" | "BUSINESS_ADMIN" | "BUSINESS_USER",
  businessId: string | null,
  profileAccessId: string | null = null,
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
      profileAccessId,
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

/** Plain users holding a profile (they never log in here). */
async function seedMembers(
  businessId: string,
  profileAccessId: string,
  count: number,
) {
  await prisma.user.createMany({
    data: Array.from({ length: count }, () => {
      const id = randomUUID();

      return {
        id,
        name: "Membro",
        email: `${id}@exemplo.com.br`,
        password: "not-used-here",
        role: "BUSINESS_USER" as const,
        businessId,
        profileAccessId,
      };
    }),
  });
}

let plateSeq = 0;

async function seedVehicle(
  businessId: string,
  fuelTypeId: string,
  vehicleTypeId: string | null,
) {
  plateSeq += 1;

  return prisma.vehicle.create({
    data: {
      license_plate: `CST${String(plateSeq).padStart(4, "0")}`,
      description: "Caminhão",
      brand: "Marca",
      model: "Modelo",
      acquisition_date: new Date("2020-01-01"),
      fleet_type: "OWNED",
      current_mileage: 1_000,
      maintenance_interval_km: 10_000,
      maintenance_interval_months: 6,
      renavam: String(50000000000 + plateSeq),
      manufacturing_year: new Date("2019-01-01"),
      model_year: new Date("2020-01-01"),
      km_per_liter: 3,
      number_of_axles: 2,
      status: "ACTIVE",
      businessId,
      fuelTypeId,
      vehicleTypeId,
    },
  });
}

async function seedFleetSupport(businessId: string, suffix: string) {
  const branch = await prisma.branch.create({
    data: {
      corporate_reason: `Filial ${suffix}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: `cst-branch-${suffix}`,
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `filial-${suffix}@exemplo.com.br`,
      businessId,
    },
  });

  const driver = await prisma.driver.create({
    data: {
      name: `Motorista ${suffix}`,
      birth_date: new Date("1990-01-01"),
      cnh: `cst-cnh-${suffix}`,
      cpf: `cst-cpf-${suffix}`,
      rg: `cst-rg-${suffix}`,
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

  return { branchId: branch.id, driverId: driver.id };
}

async function seedRefuel(
  ids: {
    businessId: string;
    branchId: string;
    driverId: string;
    vehicleId: string;
    fuelTypeId: string;
  },
  refuelingDate: Date,
  liters: number,
  pricePerLiter: number,
) {
  await prisma.fuel.create({
    data: {
      ...ids,
      current_mileage: 1_000,
      liters_amount: liters,
      price_per_liter: pricePerLiter,
      total_amount: Math.round(liters * pricePerLiter * 100) / 100,
      odometer_photo: "odometer.jpg",
      refueling_date: refuelingDate,
    },
  });
}

async function listMeta(path: string, query: string, token = tokens.admin) {
  const response = await app.inject({
    method: "GET",
    url: `${path}?page=1&pageSize=1${query ? `&${query}` : ""}`,
    headers: { authorization: `Bearer ${token}` },
  });

  expect(response.statusCode, response.body).toBe(200);

  const [first, ...rows] = response.body
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  return { meta: first.meta, rows };
}

const ids: Record<string, string> = {};

beforeAll(async () => {
  await seedBusiness(CARRIER, ["FLEET", "DELIVERIES"]);
  await seedBusiness(OTHER, ["FLEET"]);
  await seedBusiness(NO_FLEET, ["DELIVERIES"]);

  // Access profiles: Operação (3 users), Financeiro (1), Auditoria (none).
  const profile = (
    name: string,
    businessId: string,
    permissions: string[] = [],
  ) =>
    prisma.profileAccess.create({
      data: {
        name,
        businessId,
        permissions: {
          create: permissions.map((key) => ({
            permissionKey: key,
            action: key,
            canRead: true,
            canWrite: false,
            businessId,
          })),
        },
      },
    });

  const operacao = await profile("Operação", CARRIER);
  const financeiro = await profile("Financeiro", CARRIER);
  await profile("Auditoria", CARRIER);
  const catalogOnly = await profile("Cadastros", CARRIER, ["fuel_type_manage"]);
  const foreign = await profile("Operação", OTHER);

  await seedMembers(CARRIER, operacao.id, 3);
  await seedMembers(CARRIER, financeiro.id, 1);
  // Another company's crowd, under a profile of the same name.
  await seedMembers(OTHER, foreign.id, 7);

  // Vehicle and fuel types.
  const truck = await prisma.vehicleType.create({
    data: { description: "Truck", number_of_axles: 3, businessId: CARRIER },
  });
  await prisma.vehicleType.create({
    data: { description: "Bitrem", number_of_axles: 7, businessId: CARRIER },
  });
  const van = await prisma.vehicleType.create({
    data: { description: "Van", number_of_axles: 2, businessId: CARRIER },
  });
  const foreignType = await prisma.vehicleType.create({
    data: { description: "Carreta", number_of_axles: 5, businessId: OTHER },
  });

  const diesel = await prisma.fuelType.create({
    data: { description: "Diesel", businessId: CARRIER },
  });
  const gasolina = await prisma.fuelType.create({
    data: { description: "Gasolina", businessId: CARRIER },
  });
  await prisma.fuelType.create({
    data: { description: "GNV", businessId: CARRIER },
  });
  const foreignDiesel = await prisma.fuelType.create({
    data: { description: "Diesel", businessId: OTHER },
  });
  await prisma.fuelType.create({
    data: { description: "Diesel", businessId: NO_FLEET },
  });

  ids.diesel = diesel.id;
  ids.gasolina = gasolina.id;
  ids.van = van.id;
  ids.operacao = operacao.id;

  // CARRIER: two vans and a truck on diesel, one van on gasoline.
  const v1 = await seedVehicle(CARRIER, diesel.id, van.id);
  await seedVehicle(CARRIER, diesel.id, van.id);
  await seedVehicle(CARRIER, diesel.id, truck.id);
  const v4 = await seedVehicle(CARRIER, gasolina.id, van.id);

  // OTHER: many vehicles and refuelings that must never reach CARRIER.
  const foreignVehicles = [];

  for (let index = 0; index < 5; index += 1) {
    foreignVehicles.push(
      await seedVehicle(OTHER, foreignDiesel.id, foreignType.id),
    );
  }

  const carrierSupport = await seedFleetSupport(CARRIER, "a");
  const otherSupport = await seedFleetSupport(OTHER, "b");

  const now = new Date();
  // 45 days back is always an earlier month, whatever today is.
  const earlier = new Date(now.getTime() - 45 * 24 * 60 * 60 * 1000);

  const carrierRefuel = (vehicleId: string, fuelTypeId: string) => ({
    businessId: CARRIER,
    ...carrierSupport,
    vehicleId,
    fuelTypeId,
  });

  await seedRefuel(carrierRefuel(v1.id, diesel.id), now, 100, 6);
  await seedRefuel(carrierRefuel(v1.id, diesel.id), now, 200, 6.3);
  await seedRefuel(carrierRefuel(v4.id, gasolina.id), now, 40, 6.5);
  // Last month: outside the card.
  await seedRefuel(carrierRefuel(v1.id, diesel.id), earlier, 900, 5);

  await seedRefuel(
    {
      businessId: OTHER,
      ...otherSupport,
      vehicleId: foreignVehicles[0].id,
      fuelTypeId: foreignDiesel.id,
    },
    now,
    5_000,
    6,
  );

  tokens.admin = await seedUser("BUSINESS_ADMIN", CARRIER);
  tokens.otherAdmin = await seedUser("BUSINESS_ADMIN", OTHER);
  tokens.noFleetAdmin = await seedUser("BUSINESS_ADMIN", NO_FLEET);
  tokens.catalogOnly = await seedUser("BUSINESS_USER", CARRIER, catalogOnly.id);
  tokens.master = await seedUser("MASTER", null);

  ({ app } = await import("@/http"));
  await app.ready();
}, 90_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

describe("GET /profile-access/list-profile-access — the cards", () => {
  it("count the company's whole search, not the page, and never another company", async () => {
    const { meta, rows } = await listMeta(
      "/profile-access/list-profile-access",
      "",
    );

    expect(rows).toHaveLength(1);
    // Operação, Financeiro, Auditoria and Cadastros; the catalog-only user
    // holds Cadastros, so it is linked too.
    expect(meta.total).toBe(4);
    expect(meta.searchMeta).toEqual({
      total: 4,
      linkedUsers: 5,
      withoutUsers: 1,
      mostUsed: { id: ids.operacao, label: "Operação", count: 3 },
    });
  });

  it("give the MASTER the picked company's numbers only", async () => {
    const { meta } = await listMeta(
      "/profile-access/list-profile-access",
      `businessId=${CARRIER}`,
      tokens.master,
    );

    expect(meta.searchMeta.linkedUsers).toBe(5);
    expect(meta.searchMeta.mostUsed.count).toBe(3);

    const other = await listMeta(
      "/profile-access/list-profile-access",
      `businessId=${OTHER}`,
      tokens.master,
    );

    expect(other.meta.searchMeta).toMatchObject({
      total: 1,
      linkedUsers: 7,
      withoutUsers: 0,
    });
  });

  it("follow the search", async () => {
    const { meta } = await listMeta(
      "/profile-access/list-profile-access",
      "search=audit",
    );

    expect(meta.searchMeta).toEqual({
      total: 1,
      linkedUsers: 0,
      withoutUsers: 1,
      mostUsed: null,
    });
  });
});

describe("GET /vehicle-type/list-vehicle-type — the cards", () => {
  it("count the company's whole search, not the page, and never another company", async () => {
    const { meta, rows } = await listMeta(
      "/vehicle-type/list-vehicle-type",
      "",
    );

    expect(rows).toHaveLength(1);
    expect(meta.total).toBe(3);
    expect(meta.searchMeta).toEqual({
      total: 3,
      vehicles: 4,
      withoutVehicles: 1,
      mostUsed: { id: ids.van, label: "Van", count: 3 },
    });
  });

  it("give the MASTER the picked company's numbers only", async () => {
    const other = await listMeta(
      "/vehicle-type/list-vehicle-type",
      `businessId=${OTHER}`,
      tokens.master,
    );

    expect(other.meta.searchMeta).toMatchObject({
      total: 1,
      vehicles: 5,
      withoutVehicles: 0,
    });
  });
});

describe("GET /fuel-type/list-fuel-type — the cards", () => {
  it("sum this business month's refuelings of the company only", async () => {
    const { meta, rows } = await listMeta("/fuel-type/list-fuel-type", "");

    expect(rows).toHaveLength(1);
    expect(meta.total).toBe(3);

    const { month, ...catalog } = meta.searchMeta;

    expect(catalog).toEqual({
      total: 3,
      vehicles: 4,
      withoutVehicles: 1,
      mostUsed: { id: ids.diesel, label: "Diesel", count: 3 },
    });

    expect(month).toEqual({
      month: expect.stringMatching(/^\d{4}-\d{2}$/),
      refuelings: 3,
      liters: 340,
      // 600 + 1260 + 260
      amount: 2120,
      mostRefueled: {
        id: ids.diesel,
        label: "Diesel",
        refuelings: 2,
        liters: 300,
        averagePricePerLiter: 6.2,
      },
    });
  });

  it("give the MASTER the picked company's month only", async () => {
    const { meta } = await listMeta(
      "/fuel-type/list-fuel-type",
      `businessId=${CARRIER}`,
      tokens.master,
    );

    expect(meta.searchMeta.month.liters).toBe(340);

    const other = await listMeta(
      "/fuel-type/list-fuel-type",
      "",
      tokens.otherAdmin,
    );

    expect(other.meta.searchMeta.month).toMatchObject({
      refuelings: 1,
      liters: 5000,
    });
  });

  it("leave the month out without Gestão de Frotas, for the company and for the MASTER", async () => {
    const own = await listMeta(
      "/fuel-type/list-fuel-type",
      "",
      tokens.noFleetAdmin,
    );

    expect(own.meta.searchMeta).toEqual({
      total: 1,
      vehicles: 0,
      withoutVehicles: 1,
      mostUsed: null,
      month: null,
    });

    const viaMaster = await listMeta(
      "/fuel-type/list-fuel-type",
      `businessId=${NO_FLEET}`,
      tokens.master,
    );

    expect(viaMaster.meta.searchMeta.month).toBeNull();
  });

  it("leave the month out for a profile that does not read Abastecimentos", async () => {
    const { meta } = await listMeta(
      "/fuel-type/list-fuel-type",
      "",
      tokens.catalogOnly,
    );

    expect(meta.searchMeta.total).toBe(3);
    expect(meta.searchMeta.month).toBeNull();
  });
});
