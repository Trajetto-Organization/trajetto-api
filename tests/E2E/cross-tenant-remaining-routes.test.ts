import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import { sign } from "jsonwebtoken";
import auth from "@/config/auth";

import { generateApiKey } from "@/shared/integration/api-key-rules";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * The rest of the routes where nothing in the URL names a tenant.
 *
 * cross-tenant-unguarded-routes.test.ts covers the users, profiles,
 * permissions, GPS trail, fuel and maintenance history and notifications.
 * These are the ones it left out: a record's AI verification (start it, read
 * its progress), kanban cards (edit, delete), a route through the public
 * integration API, and the platform-level quote and master-user routes. Each
 * is scoped only by what its use case remembers to check — and none of those
 * checks had a test.
 *
 * Same premise: knowing another company's id is not an exploit. Ids travel in
 * exports, screenshots and support tickets.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const A = "018fb100-0000-7000-8000-00000000000a";
const B = "018fb100-0000-7000-8000-00000000000b";

let tokenA = "";

/** Company A's own records, for the controls. */
const A_OWNED = { cardId: "", routeId: "" };

/** Everything company B owns, which company A must never reach. */
const B_OWNED = {
  fuelId: "",
  cardId: "",
  routeId: "",
  quoteId: "",
  masterUserId: "",
};

let routesKeyA = "";

let cnpjSeq = 0;

async function seedCarrier(id: string): Promise<void> {
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
      cnpj: String(33555444000180 + cnpjSeq),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `${id}@exemplo.com.br`,
      vehicle_limit: 10,

      // Enabled, so a refusal cannot come from "IA não habilitada".
      ai_analysis_limit: 10,
    },
  });

  for (const module of ["FLEET", "DELIVERIES"] as const) {
    await prisma.businessEntitlement.create({
      data: { businessId: id, module, enabled: true },
    });
  }
}

async function seedAdmin(businessId: string): Promise<string> {
  const id = randomUUID();
  const familyId = randomUUID();

  await prisma.user.create({
    data: {
      id,
      name: "Gestora",
      email: `${id}@exemplo.com.br`,
      password: "not-used-here",
      role: "BUSINESS_ADMIN",
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
    { subject: id, expiresIn: "30m" },
  );
}

async function seedDriver(businessId: string): Promise<string> {
  const driver = await prisma.driver.create({
    data: {
      name: "Motorista",
      birth_date: new Date("1990-01-01"),
      cnh: randomUUID().slice(0, 11),
      cpf: `cpf-${randomUUID()}`,
      rg: `rg-${randomUUID()}`,
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

  return driver.id;
}

async function seedCard(businessId: string, title: string): Promise<string> {
  const column = await prisma.kanbanColumn.create({
    data: { title: "A fazer", color: "#cccccc", position: 0, businessId },
  });

  const card = await prisma.kanbanCard.create({
    data: {
      title,
      description: "Tarefa interna",
      priority: "medium",
      dueDate: new Date(Date.now() + 86_400_000),
      position: 0,
      columnId: column.id,
    },
  });

  return card.id;
}

beforeAll(async () => {
  await seedCarrier(A);
  await seedCarrier(B);

  tokenA = await seedAdmin(A);
  const adminOfB = await seedAdmin(B);
  void adminOfB;

  // ---------------------------------------------------- fuel and its AI run
  const branch = await prisma.branch.create({
    data: {
      corporate_reason: `Filial da B ${randomUUID().slice(0, 6)}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(44555444000180 + cnpjSeq),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `filial-${randomUUID()}@exemplo.com.br`,
      businessId: B,
    },
  });

  const fuelType = await prisma.fuelType.create({
    data: { description: `Diesel ${randomUUID().slice(0, 6)}`, businessId: B },
  });

  const driverB = await seedDriver(B);

  const vehicle = await prisma.vehicle.create({
    data: {
      license_plate: randomUUID().slice(0, 7).toUpperCase(),
      description: "Caminhão da B",
      brand: "Marca",
      model: "Modelo",
      acquisition_date: new Date("2020-01-01"),
      fleet_type: "OWNED",
      current_mileage: 10_000,
      maintenance_interval_km: 10_000,
      maintenance_interval_months: 6,
      renavam: randomUUID().slice(0, 11),
      manufacturing_year: new Date("2019-01-01"),
      model_year: new Date("2020-01-01"),
      km_per_liter: 3,
      number_of_axles: 2,
      status: "ACTIVE",
      businessId: B,
      branchId: branch.id,
      fuelTypeId: fuelType.id,
    },
  });

  B_OWNED.fuelId = (
    await prisma.fuel.create({
      data: {
        current_mileage: 10_500,
        liters_amount: 120,
        price_per_liter: 6,
        total_amount: 720,
        odometer_photo: "fuelOdometer/b/foto.webp",
        businessId: B,
        branchId: branch.id,
        vehicleId: vehicle.id,
        fuelTypeId: fuelType.id,
        driverId: driverB,
      },
    })
  ).id;

  const period = await prisma.aIUsagePeriod.create({
    data: { businessId: B, periodStart: new Date("2026-09-01") },
  });

  // B's verification, mid-run: what A must not be able to watch.
  await prisma.aIAnalysisRequest.create({
    data: {
      idempotencyKey: randomUUID(),
      type: "FUEL_ODOMETER",
      recordId: B_OWNED.fuelId,
      businessId: B,
      periodId: period.id,
      requestedById: driverB,
      input: {
        odometerPhotoPath: "fuelOdometer/b/foto.webp",
        reportedMileage: 10_500,
      },
      status: "PROCESSING",
      attempts: 1,
    },
  });

  // ---------------------------------------------------- kanban
  A_OWNED.cardId = await seedCard(A, "Card da A");
  B_OWNED.cardId = await seedCard(B, "Card da B");

  // ---------------------------------------------------- routes, for the API
  const driverA = await seedDriver(A);

  A_OWNED.routeId = (
    await prisma.route.create({
      data: {
        code: 1,
        name: "Rota da A",
        scheduled_date: new Date(),
        businessId: A,
        driverId: driverA,
      },
    })
  ).id;

  B_OWNED.routeId = (
    await prisma.route.create({
      data: {
        code: 1,
        name: "Rota da B",
        scheduled_date: new Date(),
        businessId: B,
        driverId: driverB,
      },
    })
  ).id;

  const key = generateApiKey();

  await prisma.apiKey.create({
    data: {
      name: "Integração da A",
      prefix: key.prefix,
      token_hash: key.tokenHash,
      scopes: ["routes:read"],
      businessId: A,
    },
  });

  routesKeyA = key.token;

  // ---------------------------------------------------- platform level
  B_OWNED.quoteId = (
    await prisma.quote.create({
      data: {
        name: "Interessada",
        company: "Transportadora Interessada",
        email: `lead-${randomUUID()}@exemplo.com.br`,
        telephone: "11999999999",
        fleet_size: "10-50",
      },
    })
  ).id;

  B_OWNED.masterUserId = (
    await prisma.user.create({
      data: {
        name: "Operadora da Plataforma",
        email: `master-${randomUUID()}@exemplo.com.br`,
        password: "not-used-here",
        role: "MASTER",
      },
    })
  ).id;

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

/**
 * Refused by the RULE, and not by anything upstream of it: a 422 or a
 * validation error means the request never reached the check under test,
 * and so does an entitlement refusal or a 500.
 */
function expectRefused(
  response: { statusCode: number; body: string },
  what: string,
): void {
  expect(
    response.statusCode,
    `${what}: PASSOU — ${response.body.slice(0, 200)}`,
  ).toBeGreaterThanOrEqual(400);

  expect(
    response.statusCode,
    `${what}: recusado pelo schema, não pela regra — ${response.body.slice(0, 200)}`,
  ).not.toBe(422);

  expect(
    response.body.includes('"code":"VALIDATION_ERROR"'),
    `${what}: recusado pelo schema, não pela regra`,
  ).toBe(false);

  expect(
    response.body.includes("MODULE_NOT_ENABLED"),
    `${what}: recusado pelo entitlement, não pela regra de tenant`,
  ).toBe(false);

  expect(
    response.statusCode,
    `${what}: estourou em vez de recusar — ${response.body.slice(0, 200)}`,
  ).toBeLessThan(500);
}

const asA = () => ({ authorization: `Bearer ${tokenA}` });

describe("another carrier's AI verification", () => {
  it("cannot be started on another company's refuelling", async () => {
    const before = await prisma.aIAnalysisRequest.count({
      where: { recordId: B_OWNED.fuelId },
    });

    const response = await app.inject({
      method: "POST",
      url: `/ai-analysis/request/fuel/${B_OWNED.fuelId}`,
      headers: asA(),
    });

    // 404, the answer for a record that does not exist. A 400 ("no photo",
    // "AI not enabled") would confirm the record is there — and the charge
    // would land on B's quota.
    expect(response.statusCode, response.body.slice(0, 200)).toBe(404);

    // The use case's 404, not the router's: a renamed route would answer 404
    // too, and this case would pass without reaching any tenant check.
    expect(response.headers["x-error-code"]).not.toBe("ROUTE_NOT_FOUND");

    expect(
      await prisma.aIAnalysisRequest.count({
        where: { recordId: B_OWNED.fuelId },
      }),
    ).toBe(before);
  });

  it("cannot be watched on another company's refuelling", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/ai-analysis/progress/fuel/${B_OWNED.fuelId}`,
      headers: asA(),
    });

    if (response.statusCode === 200) {
      // B's run is PROCESSING right now. "none" is what A would see for a
      // record that never had an analysis — which is the only safe answer.
      expect(response.json().data.status, "o andamento da IA da B vazou").toBe(
        "none",
      );

      return;
    }

    expectRefused(response, "andamento da IA da B");
  });
});

describe("another carrier's kanban cards", () => {
  it("cannot be edited", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: `/kanban/card/update/${B_OWNED.cardId}`,
      headers: asA(),
      payload: { title: "Card Sequestrado" },
    });

    expectRefused(response, "editar card da B");

    expect(
      (
        await prisma.kanbanCard.findUniqueOrThrow({
          where: { id: B_OWNED.cardId },
        })
      ).title,
    ).toBe("Card da B");
  });

  it("can be edited by their own company", async () => {
    // The control: the same payload on A's own card goes through, so the
    // refusal above is the tenant rule and not a payload nobody accepts.
    const response = await app.inject({
      method: "PATCH",
      url: `/kanban/card/update/${A_OWNED.cardId}`,
      headers: asA(),
      payload: { title: "Card Editado" },
    });

    expect(response.statusCode, response.body.slice(0, 200)).toBe(200);
  });

  it("cannot be deleted", async () => {
    const response = await app.inject({
      method: "DELETE",
      url: `/kanban/card/delete/${B_OWNED.cardId}`,
      headers: asA(),
    });

    expectRefused(response, "apagar card da B");

    expect(
      await prisma.kanbanCard.count({ where: { id: B_OWNED.cardId } }),
    ).toBe(1);
  });
});

describe("another carrier's route, through the public API", () => {
  const call = (routeId: string) =>
    app.inject({
      method: "GET",
      url: `/integration/v1/routes/${routeId}`,
      headers: { authorization: `Bearer ${routesKeyA}` },
    });

  it("answers the same 404 as a route that does not exist", async () => {
    const response = await call(B_OWNED.routeId);

    expect(response.statusCode, response.body.slice(0, 200)).toBe(404);
    expect(response.body).not.toContain("Rota da B");
  });

  it("answers the key's own company", async () => {
    const response = await call(A_OWNED.routeId);

    expect(response.statusCode, response.body.slice(0, 200)).toBe(200);
  });
});

describe("the platform's own records", () => {
  it("do not let a company admin change a sales lead", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: `/quote/update-quote-status/${B_OWNED.quoteId}`,
      headers: asA(),
      payload: { status: "CLOSED" },
    });

    expect(response.statusCode, response.body.slice(0, 200)).toBe(403);

    expect(
      (await prisma.quote.findUniqueOrThrow({ where: { id: B_OWNED.quoteId } }))
        .status,
    ).toBe("PENDING");
  });

  it("do not let a company admin delete a sales lead", async () => {
    const response = await app.inject({
      method: "DELETE",
      url: `/quote/delete-quote/${B_OWNED.quoteId}`,
      headers: asA(),
    });

    expect(response.statusCode, response.body.slice(0, 200)).toBe(403);
    expect(await prisma.quote.count({ where: { id: B_OWNED.quoteId } })).toBe(
      1,
    );
  });

  it("do not let a company admin edit a platform operator", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: `/user/update-master-user/${B_OWNED.masterUserId}`,
      headers: asA(),
      payload: { name: "Operadora Sequestrada" },
    });

    expect(response.statusCode, response.body.slice(0, 200)).toBe(403);

    expect(
      (
        await prisma.user.findUniqueOrThrow({
          where: { id: B_OWNED.masterUserId },
        })
      ).name,
    ).toBe("Operadora da Plataforma");
  });

  it("do not let a company admin delete a platform operator", async () => {
    const response = await app.inject({
      method: "DELETE",
      url: `/user/delete-master-user/${B_OWNED.masterUserId}`,
      headers: asA(),
    });

    expect(response.statusCode, response.body.slice(0, 200)).toBe(403);
    expect(
      await prisma.user.count({ where: { id: B_OWNED.masterUserId } }),
    ).toBe(1);
  });
});
