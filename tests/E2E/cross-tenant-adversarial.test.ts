import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { sign } from "jsonwebtoken";
import auth from "@/config/auth";

/**
 * One company trying to reach another, route by route.
 *
 * This file exists because an adversarial audit found SIX routes where the
 * record's id was never tied back to the caller's tenant — and the whole
 * suite, 917 tests, passed identically before and after the fixes. None of
 * those holes had a test, which is why they existed.
 *
 * The house rule is that an id is not access control: it travels in exports,
 * in screenshots, in support tickets and in ERP integrations. Knowing another
 * company's id is therefore the premise, not the exploit — what each test here
 * proves is that knowing is not enough.
 *
 * And the answer is always 404, never 403: a distinct 403 would confirm the
 * record exists, which is half of what somebody sweeping ids wants to know.
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const A = "018fc000-0000-7000-8000-00000000000a";
const B = "018fc000-0000-7000-8000-00000000000b";

const USER_A = "018fc000-0000-7000-8000-0000000000a1";
const DRIVER_USER_A = "018fc000-0000-7000-8000-0000000000a2";

const DRIVER_A = "018fc000-0000-7000-8000-0000000000d1";
const DRIVER_A2 = "018fc000-0000-7000-8000-0000000000d3";
const DRIVER_B = "018fc000-0000-7000-8000-0000000000d2";

let tokenA: string;
let driverTokenA: string;

const created: { fineB?: string; partB?: string; vehicleB?: string } = {};

let fuelTypeB = "";
let supplierB = "";

async function seedBusiness(id: string, cnpj: string): Promise<void> {
  await prisma.business.create({
    data: {
      id,
      corporate_reason: `Transportadora ${id.slice(-1)}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj,
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `adv-${id}-${randomUUID()}@exemplo.com.br`,
    },
  });

  // BOTH modules. Without FLEET, the part, fuel and fine routes answer 403
  // MODULE_NOT_ENABLED before reaching the tenant rule — and the test would
  // pass proving the entitlement works, not the isolation.
  await prisma.businessEntitlement.createMany({
    data: [
      { businessId: id, module: "DELIVERIES", enabled: true },
      { businessId: id, module: "FLEET", enabled: true },
    ],
  });
}

async function seedDriver(id: string, businessId: string): Promise<void> {
  await prisma.driver.create({
    data: {
      id,
      name: `Motorista ${id.slice(-2)}`,
      birth_date: new Date("1990-01-01"),
      cnh: `cnh-${id.slice(-8)}`,
      cpf: `cpf-${id.slice(-8)}`,
      rg: `rg-${id.slice(-8)}`,
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
  await seedBusiness(A, "66222888000101");
  await seedBusiness(B, "66222888000102");

  await seedDriver(DRIVER_A, A);
  await seedDriver(DRIVER_A2, A);
  await seedDriver(DRIVER_B, B);

  await prisma.user.create({
    data: {
      id: USER_A,
      name: "Gestora A",
      email: `gestora-a-${randomUUID()}@exemplo.com.br`,
      password: "nao-usado",
      role: "BUSINESS_ADMIN",
      businessId: A,
    },
  });

  await prisma.user.create({
    data: {
      id: DRIVER_USER_A,
      name: "Motorista A",
      email: `motorista-a-${randomUUID()}@exemplo.com.br`,
      password: "nao-usado",
      role: "BUSINESS_USER",
      businessId: A,
      driverId: DRIVER_A,
    },
  });

  tokenA = await mintToken(USER_A, A, null);
  driverTokenA = await mintToken(DRIVER_USER_A, A, DRIVER_A);

  // ------------------------------------------------ what company B holds
  const supplier = await prisma.supplier.create({
    data: { name: "Fornecedor B", cnpj: "77222888000199", businessId: B },
  });

  supplierB = supplier.id;

  const part = await prisma.part.create({
    data: {
      description: "Peça secreta da B",
      unit_price: 99.9,
      businessId: B,
      supplierId: supplier.id,
    },
  });

  created.partB = part.id;

  const fuelType = await prisma.fuelType.create({
    data: { description: "Diesel", businessId: B },
  });

  fuelTypeB = fuelType.id;

  const vehicle = await prisma.vehicle.create({
    data: {
      description: "Caminhão da B",
      license_plate: `BBB9B${Math.floor(Math.random() * 90) + 10}`,
      brand: "Scania",
      model: "R450",
      acquisition_date: new Date(),
      fleet_type: "OWNED",
      current_mileage: 0,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: `rnv-adv-${randomUUID().slice(0, 8)}`,
      manufacturing_year: new Date(),
      model_year: new Date(),
      km_per_liter: 3,
      number_of_axles: 3,
      status: "ACTIVE",
      businessId: B,
      fuelTypeId: fuelType.id,
    },
  });

  created.vehicleB = vehicle.id;

  const branch = await prisma.branch.create({
    data: {
      corporate_reason: `Filial B ${randomUUID().slice(0, 8)}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: `88${Math.floor(Math.random() * 1e12)}`.slice(0, 14),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `filial-b-${randomUUID()}@exemplo.com.br`,
      businessId: B,
    },
  });

  const code = await prisma.trafficViolationCode.create({
    data: {
      code: `ADV${Math.floor(Math.random() * 100000)}`,
      description: "Excesso de velocidade",
      legal_basis: "CTB art. 218",
      violator_type: "Condutor",
      gravity: "SERIOUS",
      gravity_raw: "Grave",
      points: 5,
      competent_agency: "Estadual",
    },
  });

  const fine = await prisma.fine.create({
    data: {
      businessId: B,
      branchId: branch.id,
      driverId: DRIVER_B,
      vehicleId: vehicle.id,
      trafficViolationCodeId: code.id,
      violation_date: new Date(),
      due_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      amount: 195.23,
      points: 5,
    },
  });

  created.fineB = fine.id;

  await prisma.fuel.create({
    data: {
      businessId: B,
      branchId: branch.id,
      vehicleId: vehicle.id,
      driverId: DRIVER_B,
      fuelTypeId: fuelType.id,

      refueling_date: new Date("2026-01-10T12:00:00.000Z"),

      current_mileage: 1000,
      liters_amount: 300,
      price_per_liter: 6,

      // The number the test looks for in the response body further down.
      total_amount: 1800,

      odometer_photo: "fuel/b/odometro.jpg",
    },
  });

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await prisma.fuel.deleteMany({ where: { businessId: { in: [A, B] } } });

  await prisma.part.deleteMany({ where: { businessId: { in: [A, B] } } });
  await prisma.supplier.deleteMany({ where: { businessId: { in: [A, B] } } });

  await prisma.fine.deleteMany({ where: { businessId: { in: [A, B] } } });

  // After the fines and the refuellings, which point at them.
  await prisma.vehicle.deleteMany({ where: { businessId: { in: [A, B] } } });
  await prisma.fuelType.deleteMany({ where: { businessId: { in: [A, B] } } });

  await prisma.branch.deleteMany({ where: { businessId: { in: [A, B] } } });

  await prisma.trafficViolationCode.deleteMany({
    where: { description: "Excesso de velocidade" },
  });

  await prisma.refreshToken.deleteMany({
    where: { userId: { in: [USER_A, DRIVER_USER_A] } },
  });

  await prisma.user.deleteMany({
    where: { id: { in: [USER_A, DRIVER_USER_A] } },
  });

  await prisma.driver.deleteMany({
    where: { id: { in: [DRIVER_A, DRIVER_A2, DRIVER_B] } },
  });

  await prisma.businessEntitlement.deleteMany({
    where: { businessId: { in: [A, B] } },
  });

  await prisma.business.deleteMany({ where: { id: { in: [A, B] } } });

  await app?.close();
  await prisma.$disconnect();
});

const call = (
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
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

/**
 * Refused by the RULE, not by the schema.
 *
 * The first version of this file passed with every fix reverted: the payloads
 * were invalid, zod refused first, and nine green tests proved that form
 * validation works. An authorisation test that never reaches authorisation is
 * worse than no test — it gives the impression of coverage exactly where there
 * is none.
 *
 * So 422/VALIDATION_ERROR is a FAILURE here: it means the request never got
 * where it needed to go.
 */
function expectRefused(
  response: { statusCode: number; body: string },
  what: string,
) {
  expect(
    response.statusCode,
    `${what} respondeu ${response.statusCode}: ${response.body.slice(0, 200)}`,
  ).toBeGreaterThanOrEqual(400);

  expect(response.statusCode, what).toBeLessThan(500);

  expect(
    response.body,
    `${what} foi recusado pelo SCHEMA, não pela regra: ${response.body.slice(0, 200)}`,
  ).not.toContain('"code":"VALIDATION_ERROR"');

  expect(response.statusCode, `${what} foi recusado pelo schema`).not.toBe(422);

  // Nor by the entitlement. A company without the module gets 403 before any
  // tenant rule, and the test would pass proving the entitlement.
  expect(
    response.body,
    `${what} foi recusado pelo ENTITLEMENT, não pela regra: ${response.body.slice(0, 200)}`,
  ).not.toContain("MODULE_NOT_ENABLED");

  expect(
    response.body,
    `${what} foi recusado pelo ENTITLEMENT, não pela regra`,
  ).not.toContain("não está habilitado");
}

describe("deleting another company’s fine", () => {
  it("is refused, and the fine is still there", async () => {
    const response = await call(
      "DELETE",
      `/fines/delete-fine/${created.fineB}/business/${A}`,
      tokenA,
    );

    expectRefused(response, "delete-fine");

    // What matters is not the status code: it is that the row is still there.
    expect(await prisma.fine.count({ where: { id: created.fineB } })).toBe(1);
  });

  it("is refused too when the route carries the victim’s company id", async () => {
    // `enforceRequestedTenant` answers first here, which is enough — but the
    // assertion is about the row, not about who refused.
    const response = await call(
      "DELETE",
      `/fines/delete-fine/${created.fineB}/business/${B}`,
      tokenA,
    );

    expectRefused(response, "delete-fine com o tenant da vítima");

    expect(await prisma.fine.count({ where: { id: created.fineB } })).toBe(1);
  });
});

describe("rewriting another company’s driver", () => {
  it("is refused, and the name is unchanged", async () => {
    const before = await prisma.driver.findUniqueOrThrow({
      where: { id: DRIVER_B },
    });

    const response = await call(
      "PATCH",
      `/driver/update-driver/${DRIVER_B}/business/${A}`,
      tokenA,
      {
        // A VALID body on purpose: zod has to let it through so that the
        // tenant rule is the one that refuses. An invalid payload here would
        // make the test pass with the fix reverted — which is exactly what
        // happened in the first version of this file.
        name: "Motorista Sequestrado",
        birth_date: "1990-01-01",
        cnh: "12345678901",
        cpf: "39053344705",
        rg: "123456789",
        cep: "01001000",
        city: "São Paulo",
        uf: "SP",
        street: "Rua Invadida",
        address_number: "1",
        status: "INACTIVE",
        contract_type: "OWNED",
      },
    );

    expectRefused(response, "update-driver");

    const after = await prisma.driver.findUniqueOrThrow({
      where: { id: DRIVER_B },
    });

    // INACTIVE is the field that matters: `session-eligibility` turns it into
    // a forced logout of their app in the middle of a route.
    expect(after.name).toBe(before.name);
    expect(after.status).toBe(before.status);
  });
});

describe("stealing another company’s part", () => {
  it("is refused even when a businessId is sent in the body", async () => {
    // The exact exploit: the ownership check lived in an `else`, and any
    // body `businessId` took the other branch and skipped it. Since decision
    // 16.100 the schema refuses the field itself, before any rule runs.
    const response = await call(
      "PATCH",
      `/part/update-part/${created.partB}/business/${A}`,
      tokenA,
      { businessId: A, description: "Reparentada" },
    );

    expect(response.statusCode, response.body).toBe(400);
    expect(JSON.parse(response.body).code).toBe("VALIDATION_ERROR");

    const after = await prisma.part.findUniqueOrThrow({
      where: { id: created.partB },
    });

    expect(after.businessId).toBe(B);
    expect(after.description).toBe("Peça secreta da B");
  });
});

describe("reading another company’s refuelling", () => {
  it("is refused by the vehicle id", async () => {
    const response = await call(
      "GET",
      `/fuel/get-previous-fuel/${created.vehicleB}?date=2030-01-01&businessId=${A}`,
      tokenA,
    );

    expectRefused(response, "get-previous-fuel");

    // And nothing leaked in the body: litres, amount, odometer and station
    // lado da parede.
    expect(JSON.stringify(response.json())).not.toContain("1800");
  });
});

describe("a driver reading a colleague’s proof", () => {
  it("is refused, even within the same company", async () => {
    // The check compared against `null` — it tested whether the delivery HAS
    // a driver, true for every delivery assigned to anyone in the company.
    const shipper = await prisma.shipper.create({
      data: { name: "Embarcador A", businessId: A },
    });

    const delivery = await prisma.delivery.create({
      data: {
        recipient_name: "Cliente do colega",
        city: "São Paulo",
        uf: "SP",
        street: "Rua",
        businessId: A,
        shipperId: shipper.id,

        // Belonging to the OTHER driver of the SAME company.
        driverId: DRIVER_A2,
        status: "DELIVERED",
        delivered_at: new Date(),
      },
    });

    const response = await call(
      "GET",
      `/delivery/proof-document/${delivery.id}/business/${A}`,
      driverTokenA,
    );

    expectRefused(response, "proof-document do colega");

    expect(JSON.stringify(response.json())).not.toContain("Cliente do colega");

    await prisma.delivery.deleteMany({ where: { id: delivery.id } });
    await prisma.shipper.deleteMany({ where: { id: shipper.id } });
  });
});

describe("a driver managing the operation’s catalogue", () => {
  it("does not create a shipper", async () => {
    const response = await call(
      "POST",
      `/shipper/create-shipper/${A}`,
      driverTokenA,
      {
        name: "Embarcador do motorista",
      },
    );

    expectRefused(response, "create-shipper como motorista");

    expect(
      await prisma.shipper.count({
        where: { businessId: A, name: "Embarcador do motorista" },
      }),
    ).toBe(0);
  });

  it("does not create an occurrence type", async () => {
    const response = await call(
      "POST",
      `/occurrence-type/create-occurrence-type/${A}`,
      driverTokenA,
      { name: "Inventado pelo motorista", blocks_delivery: false },
    );

    expectRefused(response, "create-occurrence-type como motorista");
  });
});

describe("a driver closing their own delivery without proving it", () => {
  it("is refused: the proof is what carries the evidence", async () => {
    const shipper = await prisma.shipper.create({
      data: { name: "Embarcador A2", businessId: A },
    });

    const reason = await prisma.statusChangeReason.create({
      data: { name: "Ajuste manual", businessId: A } as never,
    });

    const delivery = await prisma.delivery.create({
      data: {
        recipient_name: "Cliente sem canhoto",
        city: "São Paulo",
        uf: "SP",
        street: "Rua",
        businessId: A,
        shipperId: shipper.id,
        driverId: DRIVER_A,
        status: "IN_TRANSIT",
      },
    });

    const response = await call(
      "PATCH",
      `/delivery/update-delivery-status/${delivery.id}/business/${A}`,
      driverTokenA,
      // A well-formed body (decision 5.3 requires who received it), so the
      // refusal below is the rule's and not the schema's.
      { status: "DELIVERED", reasonId: reason.id, received_by: "Portaria" },
    );

    expectRefused(response, "override de status como motorista");

    // No photo, no signature, no GPS: exactly what
    // `register-delivery-proof` exists to require, and this path went round it.
    const after = await prisma.delivery.findUniqueOrThrow({
      where: { id: delivery.id },
    });

    expect(after.status).toBe("IN_TRANSIT");

    await prisma.delivery.deleteMany({ where: { id: delivery.id } });
    await prisma.statusChangeReason.deleteMany({ where: { id: reason.id } });
    await prisma.shipper.deleteMany({ where: { id: shipper.id } });
  });
});
