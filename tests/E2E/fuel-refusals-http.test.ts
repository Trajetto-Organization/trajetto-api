import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { sign } from "jsonwebtoken";

import { randomUUID } from "node:crypto";

import auth from "@/config/auth";

/**
 * How the fuel routes say no, over real HTTP and Postgres.
 *
 * - Another company's id answers exactly like an id that exists nowhere
 *   (decision 11.3). The create and update controllers said "Este veículo
 *   não pertence a esta empresa!" for a foreign vehicle and "Veículo não
 *   encontrado!" for an unknown one, so any carrier could tell which ids
 *   exist in some other tenant. Same for driver and fuel type.
 * - Every refusal carries a stable code; a driver's vehicle refusal is
 *   403 VEHICLE_NOT_ASSIGNED_TO_DRIVER, as on the vehicle routes (the fuel
 *   history used to answer it with a 500).
 * - The delete is read-only for a deactivated company and refuses drivers
 *   with a 403, like the update.
 * - A vehicle's history pages without repeating a refueling when two share
 *   the same creation instant.
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018fe410-0000-7000-8000-00000000000a";
const OTHER = "018fe410-0000-7000-8000-00000000000b";
const DORMANT = "018fe410-0000-7000-8000-00000000000c";

const BRANCH = "018fe410-0000-7000-8000-0000000000b1";
const OTHER_BRANCH = "018fe410-0000-7000-8000-0000000000b9";
const DORMANT_BRANCH = "018fe410-0000-7000-8000-0000000000bc";

const TRUCK = "018fe410-0000-7000-8000-0000000000c1";
const COLLEAGUE_TRUCK = "018fe410-0000-7000-8000-0000000000c2";
const OTHER_TRUCK = "018fe410-0000-7000-8000-0000000000c9";
const DORMANT_TRUCK = "018fe410-0000-7000-8000-0000000000cc";

const DRIVER = "018fe410-0000-7000-8000-0000000000d1";
const COLLEAGUE = "018fe410-0000-7000-8000-0000000000d2";
const OTHER_DRIVER = "018fe410-0000-7000-8000-0000000000d9";
const DORMANT_DRIVER = "018fe410-0000-7000-8000-0000000000dc";

const DIESEL = "018fe410-0000-7000-8000-0000000000e1";
const OTHER_DIESEL = "018fe410-0000-7000-8000-0000000000e9";
const DORMANT_DIESEL = "018fe410-0000-7000-8000-0000000000ec";
const DORMANT_UNUSED_TYPE = "018fe410-0000-7000-8000-0000000000ed";

let managerToken = "";
let driverToken = "";
let readOnlyToken = "";
let masterToken = "";

let otherCompanyFuel = "";
let dormantFuel = "";

/**
 * Two pairs of TRUCK refuelings, each pair saved in the same millisecond.
 * In one pair the row inserted first has the LOWER id, in the other the
 * HIGHER one: without the id tiebreaker Postgres returns ties in whatever
 * order it finds them (often insertion order or its reverse), which can
 * agree with "id desc" for one pair only.
 */
const PAIR_OLD = [
  "018fe410-0000-7000-8000-0000000000a1",
  "018fe410-0000-7000-8000-0000000000a2",
];
const PAIR_NEW = [
  "018fe410-0000-7000-8000-0000000000f2",
  "018fe410-0000-7000-8000-0000000000f1",
];
const TIED = [...PAIR_OLD, ...PAIR_NEW];

let cnpjSeq = 0;

async function seedBusiness(id: string, active = true) {
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
      is_active: active,
    },
  });

  await prisma.businessEntitlement.create({
    data: { businessId: id, module: "FLEET", enabled: true },
  });
}

async function seedBranch(id: string, businessId: string) {
  cnpjSeq += 1;

  await prisma.branch.create({
    data: {
      id,
      corporate_reason: `Filial ${id.slice(-2)}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(91222555000180 + cnpjSeq),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `${id}@exemplo.com.br`,
      businessId,
    },
  });
}

async function seedDriver(id: string, businessId: string) {
  await prisma.driver.create({
    data: {
      id,
      name: `Motorista ${id.slice(-2)}`,
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
  fuelTypeId: string,
  driverId: string | null,
) {
  await prisma.vehicle.create({
    data: {
      id,
      license_plate: `R${id.slice(-6)}`,
      description: `Caminhão ${id.slice(-2)}`,
      brand: "Marca",
      model: "Modelo",
      acquisition_date: new Date("2020-01-01"),
      fleet_type: "OWNED",
      current_mileage: 50_000,
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
      driverId,
    },
  });
}

async function seedUser(
  role: "MASTER" | "BUSINESS_ADMIN" | "BUSINESS_USER",
  businessId: string | null,
  extra: { driverId?: string; profileAccessId?: string } = {},
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
      driverId: extra.driverId ?? null,
      profileAccessId: extra.profileAccessId ?? null,
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

async function seedFuel(
  businessId: string,
  links: {
    branchId: string;
    vehicleId: string;
    driverId: string;
    fuelTypeId: string;
  },
  createdAt?: Date,
  id?: string,
): Promise<string> {
  const fuel = await prisma.fuel.create({
    data: {
      ...(id && { id }),
      current_mileage: 40_000,
      liters_amount: 100,
      price_per_liter: 5,
      total_amount: 500,
      odometer_photo: `odometerPhotos/${businessId}/${randomUUID()}.webp`,
      refueling_date: new Date(Date.now() - 86_400_000),
      businessId,
      ...links,
      created_from: "WEB_DASHBOARD",
      ...(createdAt && { created_at: createdAt }),
    },
  });

  return fuel.id;
}

const OWN_LINKS = {
  branchId: BRANCH,
  vehicleId: TRUCK,
  driverId: DRIVER,
  fuelTypeId: DIESEL,
};

/** A create body the web posts; links overridden per test. */
function createBody(links: Partial<typeof OWN_LINKS>) {
  return {
    current_mileage: 60_000,
    liters_amount: 40,
    price_per_liter: 5.899,
    refueling_date: new Date(Date.now() - 3_600_000).toISOString(),
    businessId: CARRIER,
    created_from: "WEB_DASHBOARD",
    ...OWN_LINKS,
    ...links,
    // Refused before the key is looked up in storage.
    photo: { key: `odometerPhotos/${CARRIER}/${Date.now()}-nao-existe.jpg` },
  };
}

function post(body: Record<string, unknown>, token = managerToken) {
  return app.inject({
    method: "POST",
    url: `/fuel/create-fuel/${CARRIER}`,
    headers: { authorization: `Bearer ${token}` },
    payload: body,
  });
}

function refusal(response: {
  statusCode: number;
  json: () => unknown;
  headers: Record<string, unknown>;
}) {
  const body = response.json() as { code?: string; message?: string };

  return {
    status: response.statusCode,
    code: body.code,
    message: body.message,
    header: response.headers["x-error-code"],
  };
}

beforeAll(async () => {
  await seedBusiness(CARRIER);
  await seedBusiness(OTHER);
  await seedBusiness(DORMANT);

  await seedBranch(BRANCH, CARRIER);
  await seedBranch(OTHER_BRANCH, OTHER);
  await seedBranch(DORMANT_BRANCH, DORMANT);

  await prisma.fuelType.createMany({
    data: [
      { id: DIESEL, description: "Diesel", businessId: CARRIER },
      { id: OTHER_DIESEL, description: "Diesel", businessId: OTHER },
      { id: DORMANT_DIESEL, description: "Diesel", businessId: DORMANT },
      { id: DORMANT_UNUSED_TYPE, description: "GNV", businessId: DORMANT },
    ],
  });

  await seedDriver(DRIVER, CARRIER);
  await seedDriver(COLLEAGUE, CARRIER);
  await seedDriver(OTHER_DRIVER, OTHER);
  await seedDriver(DORMANT_DRIVER, DORMANT);

  await seedVehicle(TRUCK, CARRIER, DIESEL, DRIVER);
  await seedVehicle(COLLEAGUE_TRUCK, CARRIER, DIESEL, COLLEAGUE);
  await seedVehicle(OTHER_TRUCK, OTHER, OTHER_DIESEL, OTHER_DRIVER);
  await seedVehicle(DORMANT_TRUCK, DORMANT, DORMANT_DIESEL, DORMANT_DRIVER);

  managerToken = await seedUser("BUSINESS_ADMIN", CARRIER);
  masterToken = await seedUser("MASTER", null);
  driverToken = await seedUser("BUSINESS_USER", CARRIER, { driverId: DRIVER });

  const readOnly = await prisma.profileAccess.create({
    data: {
      name: "Somente leitura",
      businessId: CARRIER,
      permissions: {
        create: [
          {
            permissionKey: "fuel_manage",
            action: "fuel_manage",
            canRead: true,
            canWrite: false,
            businessId: CARRIER,
          },
        ],
      },
    },
  });

  readOnlyToken = await seedUser("BUSINESS_USER", CARRIER, {
    profileAccessId: readOnly.id,
  });

  otherCompanyFuel = await seedFuel(OTHER, {
    branchId: OTHER_BRANCH,
    vehicleId: OTHER_TRUCK,
    driverId: OTHER_DRIVER,
    fuelTypeId: OTHER_DIESEL,
  });

  dormantFuel = await seedFuel(DORMANT, {
    branchId: DORMANT_BRANCH,
    vehicleId: DORMANT_TRUCK,
    driverId: DORMANT_DRIVER,
    fuelTypeId: DORMANT_DIESEL,
  });

  // A company user of a deactivated company is refused at sign-in; the one
  // who can still name it is the MASTER, and the route guard must stop him.
  await prisma.business.update({
    where: { id: DORMANT },
    data: { is_active: false },
  });

  const older = new Date(Date.now() - 3 * 3_600_000);
  const newer = new Date(Date.now() - 2 * 3_600_000);

  // Inserted in array order: a1 then a2 (lower id first), f2 then f1
  // (higher id first).
  for (const id of PAIR_OLD) await seedFuel(CARRIER, OWN_LINKS, older, id);
  for (const id of PAIR_NEW) await seedFuel(CARRIER, OWN_LINKS, newer, id);

  ({ app } = await import("@/http"));
  await app.ready();
}, 90_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

describe("POST /fuel/create-fuel — a foreign link reads like a missing one", () => {
  it.each([
    [
      "vehicle",
      { vehicleId: OTHER_TRUCK },
      { vehicleId: randomUUID() },
      "VEHICLE_NOT_FOUND",
    ],
    [
      "driver",
      { driverId: OTHER_DRIVER },
      { driverId: randomUUID() },
      "DRIVER_NOT_FOUND",
    ],
    [
      "fuel type",
      { fuelTypeId: OTHER_DIESEL },
      { fuelTypeId: randomUUID() },
      "FUEL_TYPE_NOT_FOUND",
    ],
  ])(
    "answers another company's %s exactly like an unknown id",
    async (_what, foreign, unknown, code) => {
      const foreignAnswer = refusal(await post(createBody(foreign)));
      const unknownAnswer = refusal(await post(createBody(unknown)));

      expect(foreignAnswer).toEqual(unknownAnswer);
      expect(foreignAnswer.status).toBe(400);
      expect(foreignAnswer.code).toBe(code);
      expect(foreignAnswer.header).toBe(code);
      expect(foreignAnswer.message).not.toContain("não pertence");
    },
  );

  it("answers a branch of another company with the gate's 404, the MASTER too", async () => {
    // Red before: the MASTER passes the branch gate, and the use case's
    // BranchNotBelongBusinessError went out as 400 — one code, two statuses.
    const asManager = refusal(
      await post(createBody({ branchId: OTHER_BRANCH })),
    );
    const asMaster = refusal(
      await post(createBody({ branchId: OTHER_BRANCH }), masterToken),
    );

    expect(asManager).toMatchObject({ status: 404, code: "BRANCH_NOT_FOUND" });
    expect(asMaster).toMatchObject({ status: 404, code: "BRANCH_NOT_FOUND" });
    expect(asMaster.header).toBe("BRANCH_NOT_FOUND");
  });

  it("refuses a driver at a vehicle they may not operate with 403 and a code", async () => {
    const answer = refusal(
      await post(
        {
          ...createBody({ vehicleId: COLLEAGUE_TRUCK }),
          client_submission_id: randomUUID(),
          created_from: "MOBILE_APP",
          latitude: -23.55,
          longitude: -46.63,
        },
        driverToken,
      ),
    );

    expect(answer.status).toBe(403);
    expect(answer.code).toBe("VEHICLE_NOT_ASSIGNED_TO_DRIVER");
    expect(answer.header).toBe("VEHICLE_NOT_ASSIGNED_TO_DRIVER");
    expect(answer.message).toContain("não está atribuído a você");
  });
});

describe("PATCH /fuel/update-fuel — codes and the same foreign answer", () => {
  const patch = (
    body: Record<string, unknown>,
    fuelId: string,
    token = managerToken,
  ) =>
    app.inject({
      method: "PATCH",
      url: `/fuel/update-fuel/${fuelId}/business/${CARRIER}`,
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    });

  it("answers another company's driver like an unknown one", async () => {
    const fuelId = await seedFuel(CARRIER, OWN_LINKS);

    const foreign = refusal(await patch({ driverId: OTHER_DRIVER }, fuelId));
    const unknown = refusal(await patch({ driverId: randomUUID() }, fuelId));

    expect(foreign).toEqual(unknown);
    expect(foreign).toMatchObject({ status: 400, code: "DRIVER_NOT_FOUND" });
  });

  it("answers another company's branch like an unknown one, with 404", async () => {
    const fuelId = await seedFuel(CARRIER, OWN_LINKS);

    const foreign = refusal(await patch({ branchId: OTHER_BRANCH }, fuelId));
    const unknown = refusal(await patch({ branchId: randomUUID() }, fuelId));

    expect(foreign).toEqual(unknown);
    expect(foreign).toMatchObject({ status: 404, code: "BRANCH_NOT_FOUND" });
  });

  it("answers another company's refueling like a missing one", async () => {
    const foreign = refusal(
      await patch({ price_per_liter: "5" }, otherCompanyFuel),
    );
    const missing = refusal(
      await patch({ price_per_liter: "5" }, randomUUID()),
    );

    expect(foreign).toEqual(missing);
    expect(foreign).toMatchObject({ status: 404, code: "FUEL_NOT_FOUND" });
  });

  it("refuses a driver with 403 DRIVER_CANNOT_UPDATE_FUEL", async () => {
    const fuelId = await seedFuel(CARRIER, OWN_LINKS);

    expect(
      refusal(await patch({ price_per_liter: "5" }, fuelId, driverToken)),
    ).toMatchObject({
      status: 403,
      code: "DRIVER_CANNOT_UPDATE_FUEL",
    });
  });
});

describe("DELETE /fuel/delete-fuel", () => {
  const remove = (fuelId: string, businessId = CARRIER, token = managerToken) =>
    app.inject({
      method: "DELETE",
      url: `/fuel/delete-fuel/${fuelId}/business/${businessId}`,
      headers: { authorization: `Bearer ${token}` },
    });

  it("answers another company's refueling like a missing one, and keeps it", async () => {
    const foreign = refusal(await remove(otherCompanyFuel));
    const missing = refusal(await remove(randomUUID()));

    expect(foreign).toEqual(missing);
    expect(foreign).toMatchObject({ status: 404, code: "FUEL_NOT_FOUND" });

    expect(
      await prisma.fuel.findUnique({ where: { id: otherCompanyFuel } }),
    ).not.toBeNull();
  });

  it("refuses a driver with 403 DRIVER_CANNOT_DELETE_FUEL and a read-only profile", async () => {
    const fuelId = await seedFuel(CARRIER, OWN_LINKS);

    expect(refusal(await remove(fuelId, CARRIER, driverToken))).toMatchObject({
      status: 403,
      code: "DRIVER_CANNOT_DELETE_FUEL",
    });
    expect(refusal(await remove(fuelId, CARRIER, readOnlyToken))).toMatchObject(
      {
        status: 403,
        code: "PERMISSION_DENIED",
      },
    );

    expect(
      await prisma.fuel.findUnique({ where: { id: fuelId } }),
    ).not.toBeNull();
  });

  it("is read-only for a deactivated company, even for the MASTER (TENANT_INACTIVE)", async () => {
    const answer = refusal(await remove(dormantFuel, DORMANT, masterToken));

    expect(answer.status).toBe(403);
    expect(answer.code).toBe("TENANT_INACTIVE");
    expect(
      await prisma.fuel.findUnique({ where: { id: dormantFuel } }),
    ).not.toBeNull();
  });

  it("deletes the company's own refueling", async () => {
    const fuelId = await seedFuel(CARRIER, OWN_LINKS);

    const response = await remove(fuelId);

    expect(response.statusCode).toBe(200);
    expect(await prisma.fuel.findUnique({ where: { id: fuelId } })).toBeNull();
  });
});

describe("DELETE /fuel-type/delete-fuel-type", () => {
  it("is read-only for a deactivated company, even for the MASTER (TENANT_INACTIVE)", async () => {
    // Red before: the route had no verifyBusinessActive, unlike create and
    // update, so the MASTER deleted from a deactivated company's catalog.
    const response = await app.inject({
      method: "DELETE",
      url: `/fuel-type/delete-fuel-type/${DORMANT_UNUSED_TYPE}/business/${DORMANT}`,
      headers: { authorization: `Bearer ${masterToken}` },
    });

    expect(refusal(response)).toMatchObject({
      status: 403,
      code: "TENANT_INACTIVE",
    });
    expect(
      await prisma.fuelType.findUnique({ where: { id: DORMANT_UNUSED_TYPE } }),
    ).not.toBeNull();
  });
});

describe("GET /fuel/search-fuel-by-vehicle — a vehicle's history", () => {
  const history = (vehicleId: string, query = "", token = managerToken) =>
    app.inject({
      method: "GET",
      url: `/fuel/search-fuel-by-vehicle/${vehicleId}${query ? `?${query}` : ""}`,
      headers: { authorization: `Bearer ${token}` },
    });

  const pageOf = (body: string) => {
    const [first, ...rows] = body
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    return {
      nextCursor: first.meta.searchMeta.nextCursor as string | null,
      ids: rows.map((row: { id: string }) => row.id),
    };
  };

  it("answers another company's vehicle like a missing one (404)", async () => {
    const foreign = refusal(await history(OTHER_TRUCK));
    const missing = refusal(await history(randomUUID()));

    expect(foreign).toEqual(missing);
    expect(foreign).toMatchObject({ status: 404, code: "VEHICLE_NOT_FOUND" });
  });

  it("refuses a driver on a colleague's vehicle with 403, not 500", async () => {
    expect(
      refusal(await history(COLLEAGUE_TRUCK, "", driverToken)),
    ).toMatchObject({
      status: 403,
      code: "VEHICLE_NOT_ASSIGNED_TO_DRIVER",
    });

    expect((await history(TRUCK, "", driverToken)).statusCode).toBe(200);
  });

  it("shows a driver only their own refuelings of the vehicle, no colleague's CNH", async () => {
    // A colleague fueled the driver's truck. Red before: the driver's history
    // carried that refueling with `driver: { name, cnh }` of the colleague.
    const colleagueFuel = await seedFuel(CARRIER, {
      ...OWN_LINKS,
      driverId: COLLEAGUE,
    });
    const colleagueCnh = `${COLLEAGUE.slice(-6)}cnh`;

    const asDriver = await history(TRUCK, "limit=100", driverToken);

    expect(asDriver.statusCode).toBe(200);
    expect(asDriver.body).not.toContain(colleagueFuel);
    expect(asDriver.body).not.toContain(colleagueCnh);

    const rows = asDriver.body
      .trim()
      .split("\n")
      .slice(1)
      .map((line) => JSON.parse(line) as { driverId: string });

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.driverId === DRIVER)).toBe(true);

    // The manager still reads the whole history of the vehicle.
    const asManager = await history(TRUCK, "limit=100");

    expect(asManager.body).toContain(colleagueFuel);
  });

  it("answers a cursor that names no refueling with an empty page", async () => {
    // What the in-memory twin now mirrors: Prisma's cursor on a missing row
    // returns nothing (the twin restarted from the first page).
    const response = await history(TRUCK, `cursor=${randomUUID()}`);

    expect(response.statusCode).toBe(200);
    expect(pageOf(response.body)).toEqual({ nextCursor: null, ids: [] });
  });

  it("pages refuelings saved in the same instant without repeating one", async () => {
    // The tied pairs plus newer rows other tests created: walk every page
    // one row at a time and check the order of the tied ones.
    const seen: string[] = [];
    let cursor: string | null = null;

    for (let guard = 0; guard < 50; guard += 1) {
      const response = await history(
        TRUCK,
        `limit=1${cursor ? `&cursor=${cursor}` : ""}`,
      );

      expect(response.statusCode).toBe(200);

      const page = pageOf(response.body);

      seen.push(...page.ids);
      cursor = page.nextCursor;

      if (!cursor) break;
    }

    expect(new Set(seen).size).toBe(seen.length);

    const tiedInOrder = seen.filter((id) => TIED.includes(id));

    // Newest pair first; inside each pair the id decides, descending.
    expect(tiedInOrder).toEqual([
      "018fe410-0000-7000-8000-0000000000f2",
      "018fe410-0000-7000-8000-0000000000f1",
      "018fe410-0000-7000-8000-0000000000a2",
      "018fe410-0000-7000-8000-0000000000a1",
    ]);
  });
});

describe("GET /fuel/get-previous-fuel — a driver and a colleague's vehicle", () => {
  it("answers 403 VEHICLE_NOT_ASSIGNED_TO_DRIVER, like the vehicle routes", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/fuel/get-previous-fuel/${COLLEAGUE_TRUCK}?date=${encodeURIComponent(
        new Date().toISOString(),
      )}&businessId=${CARRIER}`,
      headers: { authorization: `Bearer ${driverToken}` },
    });

    expect(refusal(response)).toMatchObject({
      status: 403,
      code: "VEHICLE_NOT_ASSIGNED_TO_DRIVER",
    });
  });
});

describe("the published document of the fuel routes", () => {
  it("describes create and delete in Portuguese, with the refusal codes", async () => {
    const document = app.swagger() as {
      paths: Record<
        string,
        Record<
          string,
          {
            summary?: string;
            responses?: Record<string, { description?: string }>;
          }
        >
      >;
    };

    const create = document.paths["/fuel/create-fuel/{businessId}"].post;
    const remove =
      document.paths["/fuel/delete-fuel/{fuelId}/business/{businessId}"].delete;

    expect(create.summary).toBe("Registra um abastecimento");
    expect(remove.summary).toBe("Exclui um abastecimento");
    expect(remove.responses?.["404"]?.description).toContain("FUEL_NOT_FOUND");
    expect(create.responses?.["400"]?.description).toContain(
      "VEHICLE_NOT_FOUND",
    );
  });

  it("documents every status the fuel routes answer, with its codes", async () => {
    const document = app.swagger() as {
      paths: Record<
        string,
        Record<string, { responses?: Record<string, { description?: string }> }>
      >;
    };

    const responsesOf = (path: string, method: string) =>
      document.paths[path][method].responses ?? {};

    const create = responsesOf("/fuel/create-fuel/{businessId}", "post");
    const update = responsesOf(
      "/fuel/update-fuel/{fuelId}/business/{businessId}",
      "patch",
    );
    const history = responsesOf(
      "/fuel/search-fuel-by-vehicle/{vehicleId}",
      "get",
    );
    const previous = responsesOf("/fuel/get-previous-fuel/{vehicleId}", "get");
    const exported = responsesOf("/fuel/export-fuel", "get");

    // The branch named in the body: the gate's 404, and the MASTER's too.
    expect(create["404"]?.description).toContain("BRANCH_NOT_FOUND");
    expect(create["404"]?.description).toContain("BUSINESS_NOT_FOUND");
    expect(create["400"]?.description).not.toContain("BRANCH_NOT_FOUND");
    expect(create["403"]?.description).toContain("BRANCH_INACTIVE");

    expect(update["404"]?.description).toContain("FUEL_NOT_FOUND");
    expect(update["404"]?.description).toContain("BRANCH_NOT_FOUND");
    expect(update["404"]?.description).toContain("BUSINESS_NOT_FOUND");
    expect(update["400"]?.description).not.toContain("BRANCH_NOT_FOUND");

    for (const responses of [history, previous]) {
      expect(responses["404"]?.description).toContain("VEHICLE_NOT_FOUND");
      expect(responses["404"]?.description).toContain("BUSINESS_NOT_FOUND");
    }

    // Session and rate limit, on every route of the plugin.
    for (const responses of [create, update, history, previous, exported]) {
      expect(responses["401"]?.description).toContain("AUTH_TOKEN_MISSING");
      expect(responses["429"]?.description).toContain("RATE_LIMITED");
    }
  });

  it("states the km rule the API enforces, and what the previous refueling carries", async () => {
    type Operation = {
      description?: string;
      parameters?: Array<{ name: string; in: string; description?: string }>;
      responses?: Record<
        string,
        {
          content?: Record<
            string,
            { schema?: { properties?: Record<string, unknown> } }
          >;
        }
      >;
    };
    const document = app.swagger() as {
      paths: Record<string, Record<string, Operation>>;
    };

    const create = document.paths["/fuel/create-fuel/{businessId}"].post;
    const update =
      document.paths["/fuel/update-fuel/{fuelId}/business/{businessId}"].patch;
    const remove =
      document.paths["/fuel/delete-fuel/{fuelId}/business/{businessId}"].delete;
    const previous = document.paths["/fuel/get-previous-fuel/{vehicleId}"].get;
    const fuelTypes =
      document.paths["/fuel-type/search-fuel-type-business"].get;

    // Red before: the create still said "à frente do odômetro" first, the
    // delete that the odometer never comes back.
    expect(create.description).toContain(
      "antes de qualquer mudança no odômetro",
    );
    expect(update.description).toContain("mudar só a data também é conferido");
    expect(update.description).toContain(
      "o veículo que ele deixa volta à maior leitura restante",
    );
    expect(remove.description).not.toContain("não volta");
    expect(remove.description).toContain("volta à maior leitura restante");

    // Red before: the whole refueling (driver, notes, price, photo).
    const reading =
      previous.responses?.["200"]?.content?.["application/json"]?.schema
        ?.properties ?? {};

    expect(Object.keys(reading).sort()).toEqual([
      "current_mileage",
      "liters_amount",
      "refueling_date",
      "vehicleId",
    ]);

    // Red before: the cursor was documented as a page of companies.
    const param = (name: string) =>
      fuelTypes.parameters?.find(
        (entry) => entry.in === "query" && entry.name === name,
      )?.description;

    expect(param("limit")).toContain("tipos de combustível");
    expect(param("cursor")).toContain("último tipo de combustível");
    expect(`${param("limit")} ${param("cursor")}`).not.toContain("empresa");
  });
});
