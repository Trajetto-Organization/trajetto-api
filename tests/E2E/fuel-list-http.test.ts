import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { PrismaClient } from "@prisma/client";
import { sign } from "jsonwebtoken";

import { randomUUID } from "node:crypto";

import auth from "@/config/auth";
import { parseCsv } from "@/shared/delivery/spreadsheet-reader";

/**
 * The refuelings list as the fleet screens read it, over real HTTP and
 * Postgres (decision 8.8): order, filters and the four cards answered by the
 * server for the whole company, not for the ten rows a page holds. The
 * cards used to add up the page ("Valor Total" of ten refuelings), and the
 * MASTER got every company's refuelings in one table. Plus the walls: other
 * companies' rows, ids and names never cross; a driver reads only their own
 * refuelings (decision 4.4); the export takes the same filters (5.8).
 *
 * The pool is counted (like connection-fan-out.test.ts) so the list is also
 * held to the two-connection budget.
 */
const pool = vi.hoisted(() => ({ inFlight: 0, peak: 0 }));

vi.mock("@/../infra/database", async () => {
  const { PrismaClient: Client } = await import("@prisma/client");

  const counted = new Client().$extends({
    query: {
      async $allOperations({ args, query }) {
        pool.inFlight += 1;
        pool.peak = Math.max(pool.peak, pool.inFlight);

        try {
          return await query(args);
        } finally {
          pool.inFlight -= 1;
        }
      },
    },
  });

  return { default: counted };
});

const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018fe200-0000-7000-8000-00000000000a";
const OTHER = "018fe200-0000-7000-8000-00000000000b";

const BR_CENTRO = "018fe200-0000-7000-8000-0000000000b1";
const BR_NORTE = "018fe200-0000-7000-8000-0000000000b2";
const BR_ALHEIA = "018fe200-0000-7000-8000-0000000000b9";

const V1 = "018fe200-0000-7000-8000-0000000000c1";
const V2 = "018fe200-0000-7000-8000-0000000000c2";
const V3 = "018fe200-0000-7000-8000-0000000000c3";
const V_ALHEIO = "018fe200-0000-7000-8000-0000000000c9";

const D_ANA = "018fe200-0000-7000-8000-0000000000d1";
const D_BRUNO = "018fe200-0000-7000-8000-0000000000d2";
const D_ALHEIO = "018fe200-0000-7000-8000-0000000000d9";

const FT_DIESEL = "018fe200-0000-7000-8000-0000000000e1";
const FT_GASOLINA = "018fe200-0000-7000-8000-0000000000e2";
const FT_ALHEIO = "018fe200-0000-7000-8000-0000000000e9";

const PLATES: Record<string, string> = {
  [V1]: "AAA1A11",
  [V2]: "BBB2B22",
  [V3]: "CCC3C33",
};

const tokens: Record<
  "admin" | "readOnly" | "noFuel" | "driver" | "otherAdmin" | "master",
  string
> = {} as never;

/**
 * Twelve refuelings, more than one page of ten, so anything computed over the
 * loaded page gives itself away. Index i (0 is the oldest):
 *   branch  = even → Centro, odd → Norte
 *   vehicle = i % 3 → V1, V2, V3
 *   fuel    = i % 4 === 0 → Gasolina, else Diesel
 *   driver  = even → Ana, odd → Bruno
 *   litres  = 10 + i, price 5.50 (amount = 5.5 × litres)
 *   odometer verified when i % 3 === 0
 */
const SEED = Array.from({ length: 12 }, (_, i) => ({
  index: i,
  branchId: i % 2 === 0 ? BR_CENTRO : BR_NORTE,
  vehicleId: [V1, V2, V3][i % 3],
  fuelTypeId: i % 4 === 0 ? FT_GASOLINA : FT_DIESEL,
  driverId: i % 2 === 0 ? D_ANA : D_BRUNO,
  liters: 10 + i,
  verified: i % 3 === 0,
}));

const ids: string[] = [];

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
      cnpj: String(41222555000180 + cnpjSeq),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `${id}@exemplo.com.br`,
    },
  });

  await prisma.businessEntitlement.create({
    data: { businessId: id, module: "FLEET", enabled: true },
  });
}

async function seedBranch(id: string, businessId: string, name: string) {
  cnpjSeq += 1;

  await prisma.branch.create({
    data: {
      id,
      corporate_reason: name,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(51222555000180 + cnpjSeq),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `${id}@exemplo.com.br`,
      businessId,
    },
  });
}

async function seedDriver(id: string, businessId: string, name: string) {
  await prisma.driver.create({
    data: {
      id,
      name,
      birth_date: new Date("1990-01-01"),
      cnh: `${id.slice(-6)}cnh`,
      cpf: `${id.slice(-6)}cpf`,
      rg: `${id.slice(-6)}rg`,
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
}

async function seedVehicle(
  id: string,
  businessId: string,
  plate: string,
  fuelTypeId: string,
) {
  await prisma.vehicle.create({
    data: {
      id,
      license_plate: plate,
      description: `Caminhão ${plate}`,
      brand: "Marca",
      model: "Modelo",
      acquisition_date: new Date("2020-01-01"),
      fleet_type: "OWNED",
      current_mileage: 100_000,
      maintenance_interval_km: 10_000,
      maintenance_interval_months: 6,
      renavam: `${id.slice(-8)}r`,
      manufacturing_year: new Date("2019-01-01"),
      model_year: new Date("2020-01-01"),
      km_per_liter: 3,
      number_of_axles: 2,
      status: "ACTIVE",
      businessId,
      fuelTypeId,
    },
  });
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

async function seedProfile(
  businessId: string,
  permissionKey: string,
  canWrite: boolean,
): Promise<string> {
  const profile = await prisma.profileAccess.create({
    data: {
      name: `Perfil ${randomUUID().slice(0, 8)}`,
      businessId,
      permissions: {
        create: [
          {
            permissionKey,
            action: permissionKey,
            canRead: true,
            canWrite,
            businessId,
          },
        ],
      },
    },
  });

  return profile.id;
}

interface FuelLine {
  id: string;
  liters_amount: number;
  total_amount: number;
  driverId: string;
  businessId: string;
  vehicle: { license_plate: string };
}

interface FuelMeta {
  total: number;
  page: number;
  pageSize: number;
  searchMeta: {
    total: number;
    totalLiters: number;
    totalAmount: number;
    verifiedOdometer: number;
    facets: Record<
      "branchId" | "vehicleId" | "fuelTypeId",
      Array<{ value: string; label?: string; count: number }>
    >;
  };
}

async function list(
  query: string,
  token = tokens.admin,
): Promise<{ status: number; meta: FuelMeta; rows: FuelLine[]; body: string }> {
  const response = await app.inject({
    method: "GET",
    url: `/fuel/list-fuel?page=1&pageSize=10${query ? `&${query}` : ""}`,
    headers: { authorization: `Bearer ${token}` },
  });

  if (response.statusCode !== 200) {
    return {
      status: response.statusCode,
      meta: {} as FuelMeta,
      rows: [],
      body: response.body,
    };
  }

  const [first, ...rest] = response.body
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  return { status: 200, meta: first.meta, rows: rest, body: response.body };
}

/** The seed index of a row, from its id. */
const indexOf = (row: { id: string }) => ids.indexOf(row.id);

const facetCount = (
  meta: FuelMeta,
  facet: "branchId" | "vehicleId" | "fuelTypeId",
  value: string,
) => meta.searchMeta.facets[facet].find((entry) => entry.value === value);

beforeAll(async () => {
  await seedBusiness(CARRIER);
  await seedBusiness(OTHER);

  await seedBranch(BR_CENTRO, CARRIER, "Filial Centro");
  await seedBranch(BR_NORTE, CARRIER, "Filial Norte");
  await seedBranch(BR_ALHEIA, OTHER, "Filial Secreta Alheia");

  await prisma.fuelType.createMany({
    data: [
      { id: FT_DIESEL, description: "Diesel", businessId: CARRIER },
      { id: FT_GASOLINA, description: "Gasolina", businessId: CARRIER },
      { id: FT_ALHEIO, description: "Etanol", businessId: OTHER },
    ],
  });

  await seedDriver(D_ANA, CARRIER, "Ana Motorista");
  await seedDriver(D_BRUNO, CARRIER, "Bruno Motorista");
  await seedDriver(D_ALHEIO, OTHER, "Motorista Alheio");

  await seedVehicle(V1, CARRIER, PLATES[V1], FT_DIESEL);
  await seedVehicle(V2, CARRIER, PLATES[V2], FT_DIESEL);
  await seedVehicle(V3, CARRIER, PLATES[V3], FT_DIESEL);
  await seedVehicle(V_ALHEIO, OTHER, "ZZZ9Z99", FT_ALHEIO);

  tokens.admin = await seedUser("BUSINESS_ADMIN", CARRIER);
  tokens.readOnly = await seedUser("BUSINESS_USER", CARRIER, {
    profileAccessId: await seedProfile(CARRIER, "fuel_manage", false),
  });
  tokens.noFuel = await seedUser("BUSINESS_USER", CARRIER, {
    profileAccessId: await seedProfile(CARRIER, "vehicle_manage", true),
  });
  tokens.driver = await seedUser("BUSINESS_USER", CARRIER, { driverId: D_ANA });
  tokens.otherAdmin = await seedUser("BUSINESS_ADMIN", OTHER);
  tokens.master = await seedUser("MASTER", null);

  const now = Date.now();

  for (const entry of SEED) {
    const fuel = await prisma.fuel.create({
      data: {
        current_mileage: 1_000 + entry.index * 100,
        liters_amount: entry.liters,
        price_per_liter: 5.5,
        total_amount: entry.liters * 5.5,
        odometer_photo: `odometerPhotos/${CARRIER}/f${entry.index}.webp`,
        odometer_verified: entry.verified,
        refueling_date: new Date(now - (12 - entry.index) * 86_400_000),
        created_at: new Date(now - (120 - entry.index * 5) * 60_000),
        businessId: CARRIER,
        branchId: entry.branchId,
        vehicleId: entry.vehicleId,
        driverId: entry.driverId,
        fuelTypeId: entry.fuelTypeId,
        created_from: "WEB_DASHBOARD",
      },
    });

    ids.push(fuel.id);
  }

  // Another company's refueling, whose names must never show up.
  await prisma.fuel.create({
    data: {
      current_mileage: 5_000,
      liters_amount: 999,
      price_per_liter: 9,
      total_amount: 8991,
      odometer_photo: `odometerPhotos/${OTHER}/alheio.webp`,
      odometer_verified: true,
      businessId: OTHER,
      branchId: BR_ALHEIA,
      vehicleId: V_ALHEIO,
      driverId: D_ALHEIO,
      fuelTypeId: FT_ALHEIO,
      created_from: "WEB_DASHBOARD",
    },
  });

  ({ app } = await import("@/http"));
  await app.ready();
}, 90_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

describe("GET /fuel/list-fuel — order", () => {
  it("defaults to newest first over the whole company", async () => {
    const { status, meta, rows } = await list("");

    expect(status).toBe(200);
    expect(meta.total).toBe(12);
    expect(rows).toHaveLength(10);
    expect(rows.map(indexOf)).toEqual([11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
  });

  it("sorts by litres across pages, page 2 continuing page 1", async () => {
    const first = await list("sort=liters_amount&order=asc");

    expect(first.rows.map(indexOf)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

    const pageTwo = await app.inject({
      method: "GET",
      url: "/fuel/list-fuel?page=2&pageSize=10&sort=liters_amount&order=asc",
      headers: { authorization: `Bearer ${tokens.admin}` },
    });

    const [meta, ...rest] = pageTwo.body
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(meta.meta.total).toBe(12);
    expect(rest.map(indexOf)).toEqual([10, 11]);
  });

  it("sorts by the amount, descending", async () => {
    const { rows } = await list("sort=total_amount&order=desc");

    expect(rows.map(indexOf)).toEqual([11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
  });

  it("sorts by the vehicle's plate and breaks ties newest first", async () => {
    const { rows } = await list("sort=vehicle_license_plate&order=asc");

    // AAA (i = 9, 6, 3, 0), then BBB (10, 7, 4, 1), then CCC (11, 8, …).
    expect(rows.map(indexOf)).toEqual([9, 6, 3, 0, 10, 7, 4, 1, 11, 8]);
  });

  it("refuses a column the server cannot order by", async () => {
    const { status, body } = await list("sort=odometer_photo");

    expect(status).toBe(400);
    expect(body).toContain("Ordenação inválida");
  });
});

describe("GET /fuel/list-fuel — filters and cards", () => {
  it("cards add up the whole company, not the page", async () => {
    const { meta } = await list("");

    const liters = SEED.reduce((sum, entry) => sum + entry.liters, 0);

    expect(meta.searchMeta.total).toBe(12);
    expect(meta.searchMeta.totalLiters).toBe(liters);
    expect(meta.searchMeta.totalAmount).toBe(liters * 5.5);
    expect(meta.searchMeta.verifiedOdometer).toBe(4);
  });

  it("filters by branch and keeps the branch options whole (disjunctive)", async () => {
    const { meta, rows } = await list(`branchId=${BR_CENTRO}`);

    const centro = SEED.filter((entry) => entry.branchId === BR_CENTRO);

    expect(meta.total).toBe(6);
    expect(rows.every((row) => indexOf(row) % 2 === 0)).toBe(true);

    expect(meta.searchMeta.totalLiters).toBe(
      centro.reduce((sum, entry) => sum + entry.liters, 0),
    );

    // The branch facet ignores its own selection…
    expect(facetCount(meta, "branchId", BR_CENTRO)?.count).toBe(6);
    expect(facetCount(meta, "branchId", BR_NORTE)?.count).toBe(6);
    expect(facetCount(meta, "branchId", BR_NORTE)?.label).toBe("Filial Norte");

    // …and the others are counted under it: even indexes spread over V1..V3.
    expect(facetCount(meta, "vehicleId", V1)?.count).toBe(2);
    expect(facetCount(meta, "vehicleId", V2)?.count).toBe(2);
    expect(facetCount(meta, "vehicleId", V1)?.label).toBe(PLATES[V1]);
  });

  it("combines facets, in the comma and the repeated form", async () => {
    const comma = await list(
      `fuelTypeId=${FT_DIESEL},${FT_GASOLINA}&vehicleId=${V2}`,
    );
    const repeated = await list(
      `fuelTypeId=${FT_DIESEL}&fuelTypeId=${FT_GASOLINA}&vehicleId=${V2}`,
    );

    expect(comma.meta.total).toBe(4);
    expect(repeated.meta.total).toBe(4);
    expect(facetCount(comma.meta, "fuelTypeId", FT_GASOLINA)?.count).toBe(1);
  });

  it("searches by plate, driver and branch name, with a facet on top", async () => {
    expect((await list("search=bbb2")).meta.total).toBe(4);
    expect((await list("search=bruno")).meta.total).toBe(6);
    expect((await list(`search=norte&vehicleId=${V1}`)).meta.total).toBe(2);
  });

  it("refuses a malformed id in a facet", async () => {
    const { status } = await list("branchId=nao-e-um-uuid");

    expect(status).toBe(400);
  });
});

describe("GET /fuel/list-fuel — isolation and roles", () => {
  it("never lists, counts or names another company's data", async () => {
    const { meta, rows, body } = await list("");

    expect(rows.every((row) => row.businessId === CARRIER)).toBe(true);
    expect(body).not.toContain("Secreta Alheia");
    expect(body).not.toContain("ZZZ9Z99");
    expect(meta.searchMeta.totalLiters).toBeLessThan(999);

    // A foreign id in the URL brings no row and no label.
    const foreign = await list(`branchId=${BR_ALHEIA}`);

    expect(foreign.meta.total).toBe(0);
    expect(foreign.body).not.toContain("Secreta Alheia");
  });

  it("refuses a manager naming another company", async () => {
    const { status } = await list(`businessId=${CARRIER}`, tokens.otherAdmin);

    expect(status).toBe(403);
  });

  it("makes the MASTER name the company", async () => {
    const without = await list("", tokens.master);

    expect(without.status).toBe(400);
    expect(without.body).toContain("BUSINESS_NOT_IDENTIFIED");

    const withCompany = await list(`businessId=${CARRIER}`, tokens.master);

    expect(withCompany.status).toBe(200);
    expect(withCompany.meta.total).toBe(12);
  });

  it("lets a read-only profile read and refuses a profile without the key", async () => {
    expect((await list("", tokens.readOnly)).status).toBe(200);
    expect((await list("", tokens.noFuel)).status).toBe(403);
  });

  it("shows a driver only their own refuelings, cards included", async () => {
    const { status, meta, rows } = await list("", tokens.driver);

    expect(status).toBe(200);
    expect(meta.total).toBe(6);
    expect(rows.every((row) => row.driverId === D_ANA)).toBe(true);
    expect(meta.searchMeta.totalLiters).toBe(
      SEED.filter((entry) => entry.driverId === D_ANA).reduce(
        (sum, entry) => sum + entry.liters,
        0,
      ),
    );
  });
});

describe("GET /fuel/search-fuel-by-vehicle — the vehicle's history picker", () => {
  const history = (vehicleId: string, query: string, token = tokens.admin) =>
    app.inject({
      method: "GET",
      url: `/fuel/search-fuel-by-vehicle/${vehicleId}?limit=20${query ? `&${query}` : ""}`,
      headers: { authorization: `Bearer ${token}` },
    });

  const rowsOf = (body: string) =>
    body
      .trim()
      .split("\n")
      .slice(1)
      .map((line) => JSON.parse(line));

  it("filters by the typed term on the server", async () => {
    const all = await history(V1, "");
    const searched = await history(V1, "search=bruno");

    expect(all.statusCode).toBe(200);
    expect(rowsOf(all.body)).toHaveLength(4);
    // V1 is refueled at i = 0, 3, 6, 9; Bruno drives the odd ones.
    expect(
      rowsOf(searched.body)
        .map(indexOf)
        .sort((a, b) => a - b),
    ).toEqual([3, 9]);
  });

  it("does not open another company's vehicle", async () => {
    const response = await history(V_ALHEIO, "");

    // 404 like a vehicle that does not exist (decision 11.3): a 403 "não
    // pertence a esta empresa" confirmed the id existed elsewhere.
    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe("VEHICLE_NOT_FOUND");
    expect(response.body).not.toContain("ZZZ9Z99");
  });
});

describe("GET /fuel/export-fuel — the screen's filters (decision 5.8)", () => {
  const exportFuels = (query: string, token = tokens.admin) =>
    app.inject({
      method: "GET",
      url: `/fuel/export-fuel?format=csv${query ? `&${query}` : ""}`,
      headers: { authorization: `Bearer ${token}` },
    });

  const rowsOf = (body: string) =>
    parseCsv(body)
      .slice(1)
      .filter((row) => row.some((cell) => String(cell ?? "") !== ""));

  it("exports only what the facets and the search keep", async () => {
    const byBranch = await exportFuels(`branchId=${BR_NORTE}`);

    expect(byBranch.statusCode).toBe(200);
    expect(rowsOf(byBranch.body)).toHaveLength(6);

    const bySearch = await exportFuels("search=AAA1A11");

    expect(rowsOf(bySearch.body)).toHaveLength(4);
  });

  it("lets the MASTER export the company he selected, and only it", async () => {
    const response = await exportFuels(`businessId=${CARRIER}`, tokens.master);

    expect(response.statusCode).toBe(200);
    expect(rowsOf(response.body)).toHaveLength(12);
    expect(response.body).not.toContain("ZZZ9Z99");
  });

  it("refuses a driver and a manager of another company", async () => {
    expect((await exportFuels("", tokens.driver)).statusCode).toBe(403);
    expect(
      (await exportFuels(`businessId=${CARRIER}`, tokens.otherAdmin))
        .statusCode,
    ).toBe(403);
  });
});

describe("the list's connection budget", () => {
  it("never holds more than two connections at once", async () => {
    const { container } = await import("tsyringe");
    const { ListFuelUseCase } = await import(
      "@/modules/fuel/usecases/list-fuel/list-fuel-usecase"
    );

    const admin = await prisma.user.findFirstOrThrow({
      where: { businessId: CARRIER, role: "BUSINESS_ADMIN" },
    });

    pool.inFlight = 0;
    pool.peak = 0;

    await container.resolve(ListFuelUseCase).execute({
      userId: admin.id,
      page: 1,
      pageSize: 10,
      branchIds: [BR_CENTRO],
      search: "a",
    });

    expect(pool.peak).toBeLessThanOrEqual(2);
  });
});
