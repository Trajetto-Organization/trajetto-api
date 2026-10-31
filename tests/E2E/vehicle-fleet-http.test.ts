import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { sign } from "jsonwebtoken";

import { randomUUID } from "node:crypto";

import auth from "@/config/auth";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * The fleet catalogue over real HTTP and Postgres (fleet-vehicle package):
 * the vehicle listing's server-side order, filters and cards (decision 8.8),
 * the per-company uniques (decision 8.1, CRIT-3), the contracted limit and
 * the status rules against routes (FLEET-VEH-1/7, decision 8.3), the delete
 * guards, the vehicle types and the dispatcher's picker (decision 4.7) — and
 * the walls around all of it: another company's rows, ids and names never
 * cross, and only who may read the fleet reads it.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018fe200-0000-7000-8000-00000000000a";
const OTHER = "018fe200-0000-7000-8000-00000000000b";
const LIMITED = "018fe200-0000-7000-8000-00000000000c";

const NORTH = "018fe200-0000-7000-8000-0000000000b1";
const SOUTH = "018fe200-0000-7000-8000-0000000000b2";
const FOREIGN_BRANCH = "018fe200-0000-7000-8000-0000000000b3";
const LIMITED_BRANCH = "018fe200-0000-7000-8000-0000000000b4";

const FUEL = "018fe200-0000-7000-8000-0000000000f1";
const FOREIGN_FUEL = "018fe200-0000-7000-8000-0000000000f2";
const LIMITED_FUEL = "018fe200-0000-7000-8000-0000000000f3";

const ANA = "018fe200-0000-7000-8000-0000000000d1";
const BRUNO = "018fe200-0000-7000-8000-0000000000d2";

const TRUCK_TYPE = "018fe200-0000-7000-8000-0000000000e1";
const FOREIGN_TYPE = "018fe200-0000-7000-8000-0000000000e2";

const FOREIGN_VEHICLE = "018fe200-0000-7000-8000-0000000000c9";

const tokens: Record<
  | "admin"
  | "readOnly"
  | "dispatcher"
  | "nobody"
  | "driver"
  | "otherAdmin"
  | "master"
  | "limitedAdmin",
  string
> = {} as never;

let adminId = "";

let cnpjSeq = 0;

async function seedBusiness(id: string, vehicleLimit = 0): Promise<void> {
  cnpjSeq += 1;

  await prisma.business.create({
    data: {
      id,
      corporate_reason: `Transportadora ${id.slice(-1)}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua das Transportadoras",
      address_number: "1",
      cnpj: String(41222555000180 + cnpjSeq),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `${id}@exemplo.com.br`,
      vehicle_limit: vehicleLimit,
    },
  });

  await prisma.businessEntitlement.createMany({
    data: [
      { businessId: id, module: "FLEET", enabled: true },
      { businessId: id, module: "DELIVERIES", enabled: true },
    ],
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
      cnh: `${id}-cnh`,
      cpf: `${id}-cpf`,
      rg: `${id}-rg`,
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

async function seedProfile(
  businessId: string,
  grants: Array<{ key: string; write: boolean }>,
): Promise<string> {
  const profile = await prisma.profileAccess.create({
    data: {
      name: `Perfil ${randomUUID().slice(0, 8)}`,
      businessId,
      permissions: {
        create: grants.map(({ key, write }) => ({
          permissionKey: key,
          action: key,
          canRead: true,
          canWrite: write,
          businessId,
        })),
      },
    },
  });

  return profile.id;
}

async function seedUser(
  role: "MASTER" | "BUSINESS_ADMIN" | "BUSINESS_USER",
  businessId: string | null,
  extra: { profileAccessId?: string; driverId?: string } = {},
): Promise<{ id: string; token: string }> {
  const id = randomUUID();
  const familyId = randomUUID();

  await prisma.user.create({
    data: {
      id,
      name: `Usuário ${role}`,
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

  return {
    id,
    token: sign(
      { tokenType: "access", sessionVersion: 0, familyId },
      auth.secret_token,
      {
        subject: id,
        expiresIn: "15m",
      },
    ),
  };
}

function vehicleRow(
  index: number,
  businessId: string,
  overrides: Record<string, unknown> = {},
) {
  const suffix = String(index).padStart(2, "0");

  return {
    description: `Veículo ${suffix}`,
    license_plate: `AAA${index % 10}A${suffix}`,
    brand: "Volvo",
    model: "FH",
    acquisition_date: new Date("2024-01-10"),
    fleet_type: "OWNED" as const,
    current_mileage: 1000 + index * 10,
    maintenance_interval_km: 10000,
    maintenance_interval_months: 6,
    renavam: `000000000${suffix}`,
    manufacturing_year: new Date("2024-01-01"),
    model_year: new Date("2025-01-01"),
    km_per_liter: 2.5,
    number_of_axles: 2,
    status: "ACTIVE" as const,
    businessId,
    fuelTypeId: FUEL,
    ...overrides,
  };
}

/**
 * Twelve vehicles, more than one page of ten. V00..V11, oldest first. By
 * index modulo 4: 0 BLOCKED, 1 INACTIVE, else ACTIVE (3 blocked, 3 inactive,
 * 6 active). Even indexes in the North branch, odd in the South.
 */
const SEED = Array.from({ length: 12 }, (_, index) => ({
  index,
  status: (index % 4 === 0
    ? "BLOCKED"
    : index % 4 === 1
      ? "INACTIVE"
      : "ACTIVE") as "BLOCKED" | "INACTIVE" | "ACTIVE",
  branchId: index % 2 === 0 ? NORTH : SOUTH,
}));

const vehicleIds: string[] = [];

interface ListMeta {
  total: number;
  searchMeta: {
    total: number;
    statusCounts: Record<string, number>;
    facets: {
      status: Array<{ value: string; count: number }>;
      branchId: Array<{ value: string; label?: string; count: number }>;
    };
  };
}

async function list(query: string, token = tokens.admin) {
  const response = await app.inject({
    method: "GET",
    url: `/vehicle/list-vehicle?page=1&pageSize=10${query ? `&${query}` : ""}`,
    headers: { authorization: `Bearer ${token}` },
  });

  if (response.statusCode !== 200) {
    return {
      status: response.statusCode,
      meta: {} as ListMeta,
      rows: [] as Array<Record<string, unknown>>,
      body: response.json() as { code?: string; message: string },
    };
  }

  const [first, ...rest] = response.body
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  return {
    status: 200,
    meta: first.meta as ListMeta,
    rows: rest as Array<Record<string, unknown>>,
    body: { message: "" } as { code?: string; message: string },
  };
}

const descriptions = (rows: Array<Record<string, unknown>>) =>
  rows.map((row) => row.description);

beforeAll(async () => {
  await seedBusiness(CARRIER);
  await seedBusiness(OTHER);
  await seedBusiness(LIMITED, 2);

  await seedBranch(NORTH, CARRIER, "Filial Norte");
  await seedBranch(SOUTH, CARRIER, "Filial Sul");
  await seedBranch(FOREIGN_BRANCH, OTHER, "Filial Secreta Alheia");
  await seedBranch(LIMITED_BRANCH, LIMITED, "Filial Limitada");

  await prisma.fuelType.createMany({
    data: [
      { id: FUEL, description: "Diesel S10", businessId: CARRIER },
      { id: FOREIGN_FUEL, description: "Diesel alheio", businessId: OTHER },
      { id: LIMITED_FUEL, description: "Diesel limitado", businessId: LIMITED },
    ],
  });

  await prisma.vehicleType.createMany({
    data: [
      {
        id: TRUCK_TYPE,
        description: "Truck",
        number_of_axles: 3,
        businessId: CARRIER,
      },
      {
        id: FOREIGN_TYPE,
        description: "Carreta alheia",
        number_of_axles: 5,
        businessId: OTHER,
      },
    ],
  });

  await seedDriver(ANA, CARRIER, "Ana");
  await seedDriver(BRUNO, CARRIER, "Bruno");

  const admin = await seedUser("BUSINESS_ADMIN", CARRIER);
  adminId = admin.id;
  tokens.admin = admin.token;

  tokens.readOnly = (
    await seedUser("BUSINESS_USER", CARRIER, {
      profileAccessId: await seedProfile(CARRIER, [
        { key: "vehicle_manage", write: false },
      ]),
    })
  ).token;

  tokens.dispatcher = (
    await seedUser("BUSINESS_USER", CARRIER, {
      profileAccessId: await seedProfile(CARRIER, [
        { key: "delivery_manage", write: true },
      ]),
    })
  ).token;

  tokens.nobody = (
    await seedUser("BUSINESS_USER", CARRIER, {
      profileAccessId: await seedProfile(CARRIER, [
        { key: "delivery_manage", write: false },
      ]),
    })
  ).token;

  tokens.driver = (
    await seedUser("BUSINESS_USER", CARRIER, { driverId: ANA })
  ).token;
  tokens.otherAdmin = (await seedUser("BUSINESS_ADMIN", OTHER)).token;
  tokens.master = (await seedUser("MASTER", null)).token;
  tokens.limitedAdmin = (await seedUser("BUSINESS_ADMIN", LIMITED)).token;

  const now = Date.now();

  for (const entry of SEED) {
    const vehicle = await prisma.vehicle.create({
      data: vehicleRow(entry.index, CARRIER, {
        status: entry.status,
        branchId: entry.branchId,
        // Ana is responsible for V02 only.
        driverId: entry.index === 2 ? ANA : null,
        vehicleTypeId: entry.index < 3 ? TRUCK_TYPE : null,
        created_at: new Date(now - (120 - entry.index * 5) * 60_000),
      }),
    });

    vehicleIds.push(vehicle.id);
  }

  // Another company's truck, on a branch whose name must never show up here.
  await prisma.vehicle.create({
    data: {
      ...vehicleRow(99, OTHER, {
        description: "Estrangeiro",
        branchId: FOREIGN_BRANCH,
        fuelTypeId: FOREIGN_FUEL,
        vehicleTypeId: FOREIGN_TYPE,
      }),
      id: FOREIGN_VEHICLE,
    },
  });

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

describe("GET /vehicle/list-vehicle — order", () => {
  it("defaults to newest first over the whole company", async () => {
    const { status, meta, rows } = await list("");

    expect(status).toBe(200);
    expect(meta.total).toBe(12);
    expect(descriptions(rows)).toEqual(
      [11, 10, 9, 8, 7, 6, 5, 4, 3, 2].map(
        (i) => `Veículo ${String(i).padStart(2, "0")}`,
      ),
    );
  });

  it("sorts by mileage across pages, not inside one", async () => {
    const first = await list("sort=current_mileage&order=asc");
    const response = await app.inject({
      method: "GET",
      url: "/vehicle/list-vehicle?page=2&pageSize=10&sort=current_mileage&order=asc",
      headers: { authorization: `Bearer ${tokens.admin}` },
    });
    const secondRows = response.body
      .trim()
      .split("\n")
      .slice(1)
      .map((line) => JSON.parse(line));

    expect(descriptions(first.rows)[0]).toBe("Veículo 00");
    expect(descriptions(secondRows)).toEqual(["Veículo 10", "Veículo 11"]);
  });

  it("sorts by a relation (branch name) with the newest first inside a tie", async () => {
    const { rows } = await list("sort=branchName&order=desc");

    // "Filial Sul" > "Filial Norte": the odd ones first, newest first.
    expect(descriptions(rows).slice(0, 3)).toEqual([
      "Veículo 11",
      "Veículo 09",
      "Veículo 07",
    ]);
  });

  it("refuses a column the server does not order by", async () => {
    const { status, body } = await list("sort=renavam");

    expect(status).toBe(400);
    expect(body.message + JSON.stringify(body)).toContain("Ordenação inválida");
  });
});

describe("GET /vehicle/list-vehicle — filters and cards", () => {
  it("filters by status over the company and keeps the cards whole", async () => {
    const { meta, rows } = await list("status=BLOCKED");

    expect(meta.total).toBe(3);
    expect(rows.every((row) => row.status === "BLOCKED")).toBe(true);

    // Disjunctive: the status cards ignore the status filter itself.
    expect(meta.searchMeta.total).toBe(12);
    expect(meta.searchMeta.statusCounts).toEqual({
      ACTIVE: 6,
      INACTIVE: 3,
      BLOCKED: 3,
      IN_ROUTE: 0,
    });
  });

  it("accepts the comma and the repeated form alike", async () => {
    const comma = await list("status=BLOCKED,INACTIVE");
    const repeated = await list("status=BLOCKED&status=INACTIVE");

    expect(comma.meta.total).toBe(6);
    expect(repeated.meta.total).toBe(6);
  });

  it("filters by branch, counts per branch and names only this company's", async () => {
    const { meta, rows } = await list(`branchId=${NORTH}`);

    expect(meta.total).toBe(6);
    expect(
      rows.every((row) => (row as { branchId: string }).branchId === NORTH),
    ).toBe(true);

    expect(meta.searchMeta.facets.branchId).toEqual([
      { value: NORTH, label: "Filial Norte", count: 6 },
      { value: SOUTH, label: "Filial Sul", count: 6 },
    ]);

    // The status cards follow the branch filter.
    expect(meta.searchMeta.total).toBe(6);
  });

  it("gives an id of another company neither rows nor a name", async () => {
    const { meta, rows, status } = await list(`branchId=${FOREIGN_BRANCH}`);

    expect(status).toBe(200);
    expect(rows).toEqual([]);
    expect(JSON.stringify(meta)).not.toContain("Secreta");
  });

  it("combines search, facets and order", async () => {
    const { meta, rows } = await list(
      `search=Veículo%201&status=ACTIVE,BLOCKED&sort=description&order=desc`,
    );

    // "Veículo 1x" = 10 (ACTIVE), 11 (ACTIVE).
    expect(meta.total).toBe(2);
    expect(descriptions(rows)).toEqual(["Veículo 11", "Veículo 10"]);
  });

  it("refuses an unknown status and a malformed id", async () => {
    expect((await list("status=QUEBRADO")).status).toBe(400);
    expect((await list("branchId=nao-e-uuid")).status).toBe(400);
  });
});

describe("GET /vehicle/list-vehicle — who reads what", () => {
  it("never shows another company's truck", async () => {
    const { rows } = await list("pageSize=10&search=Estrangeiro");

    expect(rows).toEqual([]);
  });

  it("makes the MASTER name the company, and shows only that one", async () => {
    const missing = await list("", tokens.master);
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe("BUSINESS_NOT_IDENTIFIED");

    const other = await list(`businessId=${OTHER}`, tokens.master);
    expect(other.status).toBe(200);
    expect(descriptions(other.rows)).toEqual(["Estrangeiro"]);
  });

  it("refuses a manager naming another company", async () => {
    const { status } = await list(`businessId=${CARRIER}`, tokens.otherAdmin);

    expect(status).toBe(403);
  });

  it("serves a read-only profile and refuses a profile without the fleet", async () => {
    expect((await list("", tokens.readOnly)).status).toBe(200);

    const refused = await list("", tokens.nobody);
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("PERMISSION_DENIED");
  });

  it("refuses a driver token (FLEET-VEH-6)", async () => {
    // Red before: the driver's vehicle_manage:read listed the whole fleet
    // with the other drivers' names and CNH.
    const refused = await list("", tokens.driver);

    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("PERMISSION_DENIED");
  });
});

function createBody(overrides: Record<string, unknown> = {}) {
  return {
    description: "Caminhão novo",
    license_plate: "NEW1A23",
    brand: "Scania",
    model: "R450",
    acquisition_date: "2024-05-01",
    fleet_type: "THIRD_PARTY",
    current_mileage: 500,
    maintenance_interval_km: 10000,
    maintenance_interval_months: 6,
    renavam: "55555555501",
    manufacturing_year: "2025-01-01",
    model_year: "2026-01-01",
    km_per_liter: 3.25,
    number_of_axles: 1,
    status: "ACTIVE",
    fuelTypeId: FUEL,
    ...overrides,
  };
}

function post(
  businessId: string,
  body: Record<string, unknown>,
  token = tokens.admin,
) {
  return app.inject({
    method: "POST",
    url: `/vehicle/create-vehicle/${businessId}`,
    headers: { authorization: `Bearer ${token}` },
    payload: body,
  });
}

function patch(
  vehicleId: string,
  body: Record<string, unknown>,
  token = tokens.admin,
  businessId = CARRIER,
) {
  return app.inject({
    method: "PATCH",
    url: `/vehicle/update-vehicle/${vehicleId}/business/${businessId}`,
    headers: { authorization: `Bearer ${token}` },
    payload: body,
  });
}

describe("POST /vehicle/create-vehicle — per-company uniques (decision 8.1)", () => {
  it("lets two carriers register the same aggregated truck", async () => {
    const foreign = await post(
      OTHER,
      createBody({ fuelTypeId: FOREIGN_FUEL }),
      tokens.otherAdmin,
    );
    expect(foreign.statusCode, foreign.body).toBe(201);

    // Red before: the global unique refused it and said the plate existed.
    const ours = await post(CARRIER, createBody({ license_plate: "new1a23" }));
    expect(ours.statusCode, ours.body).toBe(201);

    const stored = await prisma.vehicle.findFirstOrThrow({
      where: { businessId: CARRIER, renavam: "55555555501" },
    });
    expect(stored.license_plate).toBe("NEW1A23");
    expect(stored.km_per_liter).toBe(3.25);
    expect(stored.number_of_axles).toBe(1);
  });

  it("refuses the plate again in the same company, naming no one", async () => {
    const response = await post(
      CARRIER,
      createBody({ renavam: "55555555599" }),
    );

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "VEHICLE_PLATE_TAKEN" });
    expect(response.body).not.toContain("Transportadora");
  });

  it("answers a race on the unique index with one 201 and one 409, never a 500", async () => {
    const body = createBody({
      license_plate: "RAC3E44",
      renavam: "77777777701",
    });

    const [first, second] = await Promise.all([
      post(CARRIER, body),
      post(CARRIER, body),
    ]);

    expect([first.statusCode, second.statusCode].sort()).toEqual([201, 409]);
  });
});

describe("the contracted fleet (FLEET-VEH-1, FLEET-VEH-7)", () => {
  it("refuses a registration past the limit with a 409 that says the count", async () => {
    for (const n of [1, 2]) {
      const created = await post(
        LIMITED,
        createBody({
          license_plate: `LIM${n}A11`,
          renavam: `8888888880${n}`,
          fuelTypeId: LIMITED_FUEL,
        }),
        tokens.limitedAdmin,
      );
      expect(created.statusCode, created.body).toBe(201);
    }

    // Red before: a 500 "Houve um erro ao tentar criar o veículo".
    const refused = await post(
      LIMITED,
      createBody({
        license_plate: "LIM3A11",
        renavam: "88888888803",
        fuelTypeId: LIMITED_FUEL,
      }),
      tokens.limitedAdmin,
    );

    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: "VEHICLE_LIMIT_REACHED" });
    expect(refused.json().message).toContain("2/2");
  });

  it("lets only as many simultaneous reactivations as the contract has room for", async () => {
    // Free one slot, then race three reactivations for it.
    const limited = await prisma.vehicle.findMany({
      where: { businessId: LIMITED },
    });
    await prisma.vehicle.update({
      where: { id: limited[0].id },
      data: { status: "INACTIVE" },
    });

    const inactive = await Promise.all(
      [4, 5].map((n) =>
        prisma.vehicle.create({
          data: vehicleRow(40 + n, LIMITED, {
            license_plate: `REA${n}A11`,
            renavam: `9999999990${n}`,
            fuelTypeId: LIMITED_FUEL,
            status: "INACTIVE",
          }),
        }),
      ),
    );

    const responses = await Promise.all(
      [limited[0], ...inactive].map((vehicle) =>
        patch(vehicle.id, { status: "ACTIVE" }, tokens.limitedAdmin, LIMITED),
      ),
    );

    // The whole list, sorted: a failure shows every status that came back
    // (one 200 and two 409s, nothing else), not only a wrong count.
    expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 409, 409]);
    expect(
      await prisma.vehicle.count({
        where: { businessId: LIMITED, status: { not: "INACTIVE" } },
      }),
    ).toBe(2);
  });
});

describe("PATCH /vehicle/update-vehicle", () => {
  it("saves the description of a one-axle vehicle (FLEET-VEH-2)", async () => {
    const vehicle = await prisma.vehicle.findFirstOrThrow({
      where: { businessId: CARRIER, number_of_axles: 1 },
    });

    const response = await patch(vehicle.id, { description: "Baú seco" });

    expect(response.statusCode, response.body).toBe(200);
  });

  it("with a running route accepts only BLOCKED; with a planned one refuses INACTIVE", async () => {
    const [running, planned] = [vehicleIds[3], vehicleIds[6]];

    await prisma.route.createMany({
      data: [
        {
          code: 1,
          status: "IN_PROGRESS",
          scheduled_date: new Date("2026-09-28"),
          businessId: CARRIER,
          driverId: ANA,
          vehicleId: running,
        },
        {
          code: 2,
          status: "PLANNED",
          scheduled_date: new Date("2026-09-29"),
          businessId: CARRIER,
          driverId: BRUNO,
          vehicleId: planned,
        },
      ],
    });
    await prisma.vehicle.update({
      where: { id: running },
      data: { status: "IN_ROUTE" },
    });

    // Red before: ACTIVE was accepted with the truck on the road.
    const active = await patch(running, { status: "ACTIVE" });
    expect(active.statusCode).toBe(409);
    expect(active.json()).toMatchObject({ code: "VEHICLE_IN_ACTIVE_ROUTE" });

    expect((await patch(running, { status: "BLOCKED" })).statusCode).toBe(200);

    const inactivate = await patch(planned, { status: "INACTIVE" });
    expect(inactivate.statusCode).toBe(409);
    expect(inactivate.json()).toMatchObject({
      code: "VEHICLE_HAS_OPEN_ROUTES",
    });
    expect(inactivate.json().message).toContain("1 rota planejada");
  });

  it("answers a vehicle of another company as not found", async () => {
    const response = await patch(FOREIGN_VEHICLE, {
      description: "Sequestrado",
    });

    expect(response.statusCode).toBe(404);
    expect(
      (
        await prisma.vehicle.findUniqueOrThrow({
          where: { id: FOREIGN_VEHICLE },
        })
      ).description,
    ).toBe("Estrangeiro");
  });
});

describe("DELETE /vehicle/delete-vehicle", () => {
  it("refuses a truck that is a bill's cost centre, with the count", async () => {
    const target = vehicleIds[7];

    await prisma.accountPayable.create({
      data: {
        due_date: new Date("2026-10-10"),
        amount: 100,
        businessId: CARRIER,
        branchId: NORTH,
        registrationUserId: adminId,
        vehicleId: target,
      },
    });

    const response = await app.inject({
      method: "DELETE",
      url: `/vehicle/delete-vehicle/${target}/business/${CARRIER}`,
      headers: { authorization: `Bearer ${tokens.admin}` },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "VEHICLE_IN_USE" });
    expect(response.json().message).toContain("1 conta(s) a pagar");
    expect(await prisma.vehicle.count({ where: { id: target } })).toBe(1);
  });

  it("refuses a truck with route history instead of answering 500", async () => {
    // Red before: VehicleHasAssociatedOperationError had no mapping.
    const response = await app.inject({
      method: "DELETE",
      url: `/vehicle/delete-vehicle/${vehicleIds[6]}/business/${CARRIER}`,
      headers: { authorization: `Bearer ${tokens.admin}` },
    });

    expect(response.statusCode).toBe(409);
  });
});

describe("GET /vehicle/export-vehicle — the same list as the screen (decision 5.8)", () => {
  function exportCsv(query: string, token = tokens.admin) {
    return app.inject({
      method: "GET",
      url: `/vehicle/export-vehicle?format=csv${query}`,
      headers: { authorization: `Bearer ${token}` },
    });
  }

  it("exports only what the filters keep", async () => {
    const response = await exportCsv("&status=BLOCKED");

    expect(response.statusCode, response.body).toBe(200);

    // V00, V04, V08 are the blocked ones (V00's plate is AAA0A00).
    expect(response.body).toContain("AAA0A00");
    expect(response.body).toContain("AAA8A08");
    expect(response.body).not.toContain("AAA2A02");
    expect(response.body).not.toContain("Estrangeiro");
  });

  it("makes the MASTER name the company, and exports only that one", async () => {
    expect((await exportCsv("", tokens.master)).statusCode).toBe(400);

    const other = await exportCsv(`&businessId=${OTHER}`, tokens.master);

    expect(other.statusCode).toBe(200);
    expect(other.body).toContain("Estrangeiro");
    expect(other.body).not.toContain("Veículo 00");
  });
});

describe("GET /vehicle/search-vehicle-business — the picker (decision 4.7)", () => {
  async function search(token: string, query = "") {
    const response = await app.inject({
      method: "GET",
      url: `/vehicle/search-vehicle-business?businessId=${CARRIER}&limit=50${query}`,
      headers: { authorization: `Bearer ${token}` },
    });

    return {
      status: response.statusCode,
      rows:
        response.statusCode === 200
          ? response.body
              .trim()
              .split("\n")
              .slice(1)
              .map((line) => JSON.parse(line) as Record<string, unknown>)
          : [],
    };
  }

  it("lets a dispatcher choose a vehicle without reading the fleet record", async () => {
    // Red before: 403 without vehicle_manage:read.
    const { status, rows } = await search(tokens.dispatcher);

    expect(status).toBe(200);
    expect(rows.length).toBeGreaterThan(0);

    for (const row of rows) {
      expect(row).not.toHaveProperty("renavam");
      expect(row).not.toHaveProperty("current_mileage");
      expect(row).toHaveProperty("license_plate");
    }

    const responsible = rows.find((row) => row.id === vehicleIds[2]);
    expect(responsible?.driver).toEqual({ name: "Ana" });
  });

  it("still refuses a profile with neither grant", async () => {
    expect((await search(tokens.nobody)).status).toBe(403);
  });

  it("searches by the typed plate on the server", async () => {
    const { rows } = await search(tokens.admin, "&search=aaa2a02");

    expect(rows.map((row) => row.id)).toEqual([vehicleIds[2]]);
  });
});

describe("vehicle types", () => {
  it("refuses to delete a type still on vehicles (FLEET-VTYPE-2)", async () => {
    const response = await app.inject({
      method: "DELETE",
      url: `/vehicle-type/delete-vehicle-type/${TRUCK_TYPE}/business/${CARRIER}`,
      headers: { authorization: `Bearer ${tokens.admin}` },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "VEHICLE_TYPE_IN_USE" });
    expect(response.json().message).toContain("3 veículo(s)");
    expect(
      await prisma.vehicle.count({ where: { vehicleTypeId: TRUCK_TYPE } }),
    ).toBe(3);
  });

  it("answers another company's type as not found and leaves it where it is", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: `/vehicle-type/update-vehicle-type/${FOREIGN_TYPE}/business/${OTHER}`,
      headers: { authorization: `Bearer ${tokens.master}` },
      payload: { required_cnh_category: "E" },
    });
    expect(response.statusCode, response.body).toBe(200);

    const crossed = await app.inject({
      method: "PATCH",
      url: `/vehicle-type/update-vehicle-type/${FOREIGN_TYPE}/business/${CARRIER}`,
      headers: { authorization: `Bearer ${tokens.master}` },
      payload: { description: "Movido" },
    });

    // Red before: found by id alone and rewritten with the path's company.
    expect(crossed.statusCode).toBe(404);

    const stored = await prisma.vehicleType.findUniqueOrThrow({
      where: { id: FOREIGN_TYPE },
    });
    expect(stored.businessId).toBe(OTHER);
    expect(stored.description).toBe("Carreta alheia");
    expect(stored.required_cnh_category).toBe("E");
  });

  it("lists one company's types sorted by how many vehicles use them", async () => {
    await prisma.vehicleType.create({
      data: { description: "Van", number_of_axles: 2, businessId: CARRIER },
    });

    const response = await app.inject({
      method: "GET",
      url: "/vehicle-type/list-vehicle-type?page=1&pageSize=10&sort=vehicleCount&order=desc",
      headers: { authorization: `Bearer ${tokens.admin}` },
    });

    const [meta, ...rows] = response.body
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(meta.meta.total).toBe(2);
    expect(rows.map((row: { description: string }) => row.description)).toEqual(
      ["Truck", "Van"],
    );
    expect(rows[0]._count.vehicles).toBe(3);
  });
});

describe("GET /vehicle-checklist/list-vehicle-checklist", () => {
  const checklistBase = {
    current_mileage: 1000,
    tires_condition: "good",
    bumpers_condition: "good",
    windshield_condition: "good",
    mirrors_condition: "good",
    steering_wheel_condition: "good",
    battery_condition: "good",
    spare_tire_condition: "good",
    photos: [],
    businessId: CARRIER,
  };

  beforeAll(async () => {
    // Twelve inspections: 0,3,6,9 rejected, 1,4,7,10 with restrictions, the
    // rest approved; Ana did the even ones, Bruno the odd ones.
    await prisma.vehicleChecklist.createMany({
      data: Array.from({ length: 12 }, (_, index) => ({
        ...checklistBase,
        overall_condition:
          index % 3 === 0
            ? "rejected"
            : index % 3 === 1
              ? "approved_with_restrictions"
              : "approved",
        driverId: index % 2 === 0 ? ANA : BRUNO,
        branchId: index % 2 === 0 ? NORTH : SOUTH,
        vehicleId: vehicleIds[index],
        created_at: new Date(Date.now() - (60 - index) * 60_000),
      })),
    });
  });

  async function checklists(query: string, token = tokens.admin) {
    const response = await app.inject({
      method: "GET",
      url: `/vehicle-checklist/list-vehicle-checklist?page=1&pageSize=10${query}`,
      headers: { authorization: `Bearer ${token}` },
    });

    const [first, ...rows] = response.body
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    return { status: response.statusCode, meta: first.meta, rows };
  }

  it("counts the condition cards over the company, not the page (FLEET-STATS-1)", async () => {
    const { meta, rows } = await checklists("");

    expect(rows).toHaveLength(10);
    expect(meta.total).toBe(12);
    expect(meta.searchMeta).toMatchObject({
      total: 12,
      approved: 4,
      approvedWithRestrictions: 4,
      rejected: 4,
    });
  });

  it("filters by condition and branch on the server", async () => {
    const { meta } = await checklists(
      `&overall_condition=rejected&branchId=${NORTH}`,
    );

    // Rejected are 0,3,6,9; North are the even ones → 0 and 6.
    expect(meta.total).toBe(2);
    expect(meta.searchMeta.rejected).toBe(2);
    expect(meta.searchMeta.total).toBe(6);
  });

  it("shows a driver only the inspections they made (decision 4.4)", async () => {
    // Red before: a driver token listed the whole company's inspections.
    const { status, meta, rows } = await checklists("", tokens.driver);

    expect(status).toBe(200);
    expect(meta.total).toBe(6);
    expect(
      rows.every((row: { driverId: string }) => row.driverId === ANA),
    ).toBe(true);
  });

  it("makes the MASTER name the company", async () => {
    const { status } = await checklists("", tokens.master);

    expect(status).toBe(400);
  });
});

describe("search by the id the tables show (spec §5)", () => {
  // The web shows each record's id compact (its last twelve characters) and
  // copies it whole from the row menu. These three lists matched only an
  // exact whole UUID, case-sensitively: the compact id found nothing, nor did
  // an upper-case paste.
  const tail = (id: string) => id.slice(-12);

  it("finds a vehicle by its tail and by its whole id in any case", async () => {
    const target = vehicleIds[0];

    const byTail = await list(`search=${tail(target)}`);

    expect(byTail.status).toBe(200);
    expect(byTail.rows.map((row) => row.id)).toEqual([target]);
    expect(byTail.meta.total).toBe(1);

    const byId = await list(`search=${target.toUpperCase()}`);

    expect(byId.rows.map((row) => row.id)).toEqual([target]);
  });

  it("never finds another company's vehicle by its id", async () => {
    expect((await list(`search=${tail(FOREIGN_VEHICLE)}`)).rows).toEqual([]);
    expect((await list(`search=${FOREIGN_VEHICLE}`)).rows).toEqual([]);

    // Its own company finds it, by the same tail.
    const theirs = await list(
      `businessId=${OTHER}&search=${tail(FOREIGN_VEHICLE)}`,
      tokens.master,
    );

    expect(theirs.rows.map((row) => row.id)).toEqual([FOREIGN_VEHICLE]);
  });

  async function types(search: string) {
    const response = await app.inject({
      method: "GET",
      url: `/vehicle-type/list-vehicle-type?page=1&pageSize=10&search=${search}`,
      headers: { authorization: `Bearer ${tokens.admin}` },
    });

    const [, ...rows] = response.body
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    return rows.map((row: { id: string }) => row.id);
  }

  it("finds a vehicle type by its tail, never another company's", async () => {
    expect(await types(tail(TRUCK_TYPE))).toEqual([TRUCK_TYPE]);
    expect(await types(TRUCK_TYPE.toUpperCase())).toEqual([TRUCK_TYPE]);
    expect(await types(tail(FOREIGN_TYPE))).toEqual([]);
  });

  it("finds a checklist by its tail and by its whole id", async () => {
    const checklist = await prisma.vehicleChecklist.findFirstOrThrow({
      where: { businessId: CARRIER },
      select: { id: true },
    });

    const search = async (term: string) => {
      const response = await app.inject({
        method: "GET",
        url: `/vehicle-checklist/list-vehicle-checklist?page=1&pageSize=10&search=${term}`,
        headers: { authorization: `Bearer ${tokens.admin}` },
      });

      const [first, ...rows] = response.body
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));

      return {
        total: first.meta.total as number,
        ids: rows.map((row: { id: string }) => row.id),
      };
    };

    expect(await search(tail(checklist.id))).toEqual({
      total: 1,
      ids: [checklist.id],
    });
    expect((await search(checklist.id.toUpperCase())).ids).toEqual([
      checklist.id,
    ]);
  });
});
