import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  readNdjson,
  seedBranch,
  seedCarrier,
  seedDriver,
  seedProfile,
  seedSupplier,
  seedUser,
  seedVehicle,
} from "./support/fleet-maint-seed";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * A driver's read of a vehicle's service-order history, against Postgres
 * (decision 4.4, FLEET-ASSIGN-1).
 *
 * The use case compared only Vehicle.driverId, so the substitute a
 * dispatcher put on truck X for the day could not see X's maintenance, and
 * any refusal was a plain Error the handler could not map: the app got a
 * 500 "erro no servidor" instead of "este veículo não é seu". Another
 * company's vehicle answered 403 "não pertence a esta empresa", confirming
 * the id existed somewhere else.
 *
 * And it streamed the raw row to the driver: the total, each part's unit
 * price and the supplier (wave 3, owner's decision: the driver sees his
 * vehicles' orders WITHOUT costs). Since 09/11/2026 a driver's line is the
 * driver's view of GET /service-order/:id, and the office keeps the money.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018fe300-0000-7000-8000-0000000000c1";
const OTHER = "018fe300-0000-7000-8000-0000000000c2";
const MISSING = "018fe300-0000-7000-8000-0000000000cf";

const vehicles = {
  own: "",
  released: "",
  running: "",
  planned: "",
  colleague: "",
  foreign: "",
};
const tokens = {
  responsible: "",
  substitute: "",
  admin: "",
  noMaintenance: "",
  profiledDriver: "",
};

const SUPPLIER_NAME = "Oficina Preço Alto";
const PART_NAME = "Filtro de óleo premium";

/** Keys that carry money or the workshop: none may reach a driver. */
const MONEY_KEYS = [
  '"total_amount"',
  '"parts_total"',
  '"unit_price"',
  '"discount_percentage"',
  '"supplier"',
  '"supplierId"',
];

/** The driver's view, key by key (service-order-views.ts). */
const DRIVER_VIEW_KEYS = [
  "branch",
  "branchId",
  "businessId",
  "completion_date",
  "created_at",
  "current_mileage_at_service",
  "date",
  "description",
  "id",
  "maintenance_type",
  "new_mileage_after_service",
  "parts",
  "responsibleUser",
  "responsibleUserId",
  "status",
  "updated_at",
  "vehicle",
  "vehicleId",
].sort();

let routeCode = 0;

async function route(
  driverId: string,
  vehicleId: string,
  status: "PLANNED" | "RELEASED" | "IN_PROGRESS" | "COMPLETED",
): Promise<void> {
  routeCode += 1;

  await prisma.route.create({
    data: {
      code: routeCode,
      status,
      scheduled_date: new Date("2026-09-29T00:00:00.000Z"),
      businessId: CARRIER,
      driverId,
      vehicleId,
    },
  });
}

async function order(
  businessId: string,
  branchId: string,
  vehicleId: string,
  responsibleUserId: string,
  description: string,
  supplierId: string | null = null,
): Promise<string> {
  const created = await prisma.serviceOrder.create({
    data: {
      description,
      maintenance_type: "EXTERNAL",
      total_amount: 300,
      businessId,
      branchId,
      vehicleId,
      responsibleUserId,
      supplierId,
    },
  });

  return created.id;
}

const history = (vehicleId: string, token: string, search?: string) =>
  readNdjson<Record<string, unknown> & { description: string }>(
    app,
    `/service-order/search-service-order-by-vehicle/${vehicleId}?limit=50` +
      (search === undefined ? "" : `&search=${encodeURIComponent(search)}`),
    token,
  );

beforeAll(async () => {
  await seedCarrier(prisma, CARRIER);
  await seedCarrier(prisma, OTHER);

  const branchId = await seedBranch(prisma, CARRIER, "Filial Pátio");
  const otherBranch = await seedBranch(prisma, OTHER, "Filial da Outra");

  const responsibleDriver = await seedDriver(prisma, CARRIER);
  const substituteDriver = await seedDriver(prisma, CARRIER);

  vehicles.own = await seedVehicle(prisma, CARRIER, {
    plate: "HIS1A11",
    branchId,
    driverId: responsibleDriver,
  });
  vehicles.released = await seedVehicle(prisma, CARRIER, {
    plate: "HIS2B22",
    branchId,
  });
  vehicles.planned = await seedVehicle(prisma, CARRIER, {
    plate: "HIS3C33",
    branchId,
  });
  vehicles.running = await seedVehicle(prisma, CARRIER, {
    plate: "HIS6F66",
    branchId,
  });
  vehicles.colleague = await seedVehicle(prisma, CARRIER, {
    plate: "HIS4D44",
    branchId,
    driverId: responsibleDriver,
  });
  vehicles.foreign = await seedVehicle(prisma, OTHER, {
    plate: "HIS5E55",
    branchId: otherBranch,
  });

  const admin = await seedUser(prisma, "Gestora", "BUSINESS_ADMIN", CARRIER);
  const otherAdmin = await seedUser(prisma, "Outra", "BUSINESS_ADMIN", OTHER);

  tokens.admin = admin.token;
  tokens.responsible = (
    await seedUser(prisma, "Responsável", "BUSINESS_USER", CARRIER, {
      driverId: responsibleDriver,
    })
  ).token;
  tokens.substitute = (
    await seedUser(prisma, "Substituto", "BUSINESS_USER", CARRIER, {
      driverId: substituteDriver,
    })
  ).token;

  // An office profile that works deliveries and never maintenance.
  tokens.noMaintenance = (
    await seedUser(prisma, "Despacho", "BUSINESS_USER", CARRIER, {
      profileAccessId: await seedProfile(prisma, CARRIER, [
        { key: "delivery_manage", write: true },
      ]),
    })
  ).token;

  // A driver login that also holds a maintenance profile: the driver map
  // lets it through, and the profile alone would pass the office's key.
  const profiledDriver = await seedDriver(prisma, CARRIER);

  tokens.profiledDriver = (
    await seedUser(prisma, "Motorista com perfil", "BUSINESS_USER", CARRIER, {
      driverId: profiledDriver,
      profileAccessId: await seedProfile(prisma, CARRIER, [
        { key: "service_order_manage", write: true },
      ]),
    })
  ).token;

  await route(profiledDriver, vehicles.own, "RELEASED");
  await route(substituteDriver, vehicles.released, "RELEASED");
  await route(substituteDriver, vehicles.running, "IN_PROGRESS");
  await route(substituteDriver, vehicles.planned, "PLANNED");
  // A finished route hands the truck back: no reading its history after.
  await route(substituteDriver, vehicles.own, "COMPLETED");

  // The money a driver must not see: a workshop and a priced part.
  const supplier = await seedSupplier(prisma, CARRIER, SUPPLIER_NAME);
  const part = await prisma.part.create({
    data: { description: PART_NAME, unit_price: 85.5, businessId: CARRIER },
  });

  const review = await order(
    CARRIER,
    branchId,
    vehicles.own,
    admin.id,
    "Revisão do próprio",
    supplier,
  );
  await prisma.serviceOrderPart.create({
    data: {
      serviceOrderId: review,
      partId: part.id,
      businessId: CARRIER,
      unit_price: 85.5,
      quantity: 2,
      discount_percentage: 10,
    },
  });
  await order(CARRIER, branchId, vehicles.own, admin.id, "Pneus do próprio");
  await order(CARRIER, branchId, vehicles.released, admin.id, "Freios da rota");
  await order(
    CARRIER,
    branchId,
    vehicles.running,
    admin.id,
    "Suspensão da rota em curso",
  );
  await order(
    CARRIER,
    branchId,
    vehicles.planned,
    admin.id,
    "Óleo do rascunho",
  );
  await order(
    CARRIER,
    branchId,
    vehicles.colleague,
    admin.id,
    "Embreagem do colega",
  );
  await order(
    OTHER,
    otherBranch,
    vehicles.foreign,
    otherAdmin.id,
    "Revisão da outra",
  );

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

describe("GET /service-order/search-service-order-by-vehicle — the driver's vehicles", () => {
  it("answers the responsible driver with the vehicle's orders", async () => {
    const result = await history(vehicles.own, tokens.responsible);

    expect(result.status, result.body).toBe(200);
    expect(result.rows.map((row) => row.description).sort()).toEqual([
      "Pneus do próprio",
      "Revisão do próprio",
    ]);
  });

  it("answers the substitute on a released route with that truck's orders", async () => {
    const result = await history(vehicles.released, tokens.substitute);

    expect(result.status, result.body).toBe(200);
    expect(result.rows.map((row) => row.description)).toEqual([
      "Freios da rota",
    ]);
  });

  it("answers the substitute on a route in progress with that truck's orders", async () => {
    const result = await history(vehicles.running, tokens.substitute);

    expect(result.status, result.body).toBe(200);
    expect(result.rows.map((row) => row.description)).toEqual([
      "Suspensão da rota em curso",
    ]);
  });

  it("refuses with a code, not a 500, a truck only on a planned or finished route", async () => {
    for (const vehicleId of [vehicles.planned, vehicles.own]) {
      const result = await history(vehicleId, tokens.substitute);

      expect(result.status, result.body).toBe(403);
      expect(JSON.parse(result.body)).toMatchObject({
        code: "VEHICLE_NOT_ASSIGNED_TO_DRIVER",
      });
      expect(result.body).not.toContain("Óleo do rascunho");
      expect(result.body).not.toContain("do próprio");
    }
  });

  it("refuses a colleague's vehicle with 403 and none of its orders", async () => {
    const result = await history(vehicles.colleague, tokens.substitute);

    expect(result.status, result.body).toBe(403);
    expect(JSON.parse(result.body).code).toBe("VEHICLE_NOT_ASSIGNED_TO_DRIVER");
    expect(result.body).not.toContain("Embreagem do colega");
  });

  it("answers another company's vehicle exactly like a missing one", async () => {
    const foreign = await history(vehicles.foreign, tokens.responsible);
    const missing = await history(MISSING, tokens.responsible);

    expect(foreign.status, foreign.body).toBe(404);
    expect(missing.status, missing.body).toBe(404);
    expect(JSON.parse(foreign.body)).toEqual(JSON.parse(missing.body));
    expect(JSON.parse(foreign.body).code).toBe("VEHICLE_NOT_FOUND");
    expect(foreign.body).not.toContain("Revisão da outra");
  });

  it("keeps the office reading any vehicle of its company", async () => {
    const result = await history(vehicles.colleague, tokens.admin);

    expect(result.status, result.body).toBe(200);
    expect(result.rows.map((row) => row.description)).toEqual([
      "Embreagem do colega",
    ]);

    const foreign = await history(vehicles.foreign, tokens.admin);

    expect(foreign.status).toBe(404);
  });

  it("gives the responsible driver no money: no total, no part price, no supplier", async () => {
    const result = await history(vehicles.own, tokens.responsible);

    expect(result.status, result.body).toBe(200);

    for (const key of MONEY_KEYS) {
      expect(result.body, key).not.toContain(key);
    }

    expect(result.body).not.toContain(SUPPLIER_NAME);
    expect(result.body).not.toContain("85.5");

    const review = result.rows.find(
      (row) => row.description === "Revisão do próprio",
    );

    expect(review?.parts).toEqual([
      { id: expect.any(String), description: PART_NAME, quantity: 2 },
    ]);

    // Nothing beyond the driver's view: the location audit and the
    // submission key the whole row carried are gone too.
    for (const row of result.rows) {
      expect(Object.keys(row).sort()).toEqual(DRIVER_VIEW_KEYS);
    }
  });

  it("gives the substitute of a released or running route no money either", async () => {
    for (const vehicleId of [vehicles.released, vehicles.running]) {
      const result = await history(vehicleId, tokens.substitute);

      expect(result.status, result.body).toBe(200);
      expect(result.rows).toHaveLength(1);

      for (const key of MONEY_KEYS) {
        expect(result.body, key).not.toContain(key);
      }
    }
  });

  it("gives a driver login with a maintenance profile the driver's view too", async () => {
    // The view follows the login's link to a driver, never its keys.
    const result = await history(vehicles.own, tokens.profiledDriver);

    expect(result.status, result.body).toBe(200);
    expect(result.rows).toHaveLength(2);

    for (const key of MONEY_KEYS) {
      expect(result.body, key).not.toContain(key);
    }

    expect(result.body).not.toContain(SUPPLIER_NAME);
    expect(result.body).not.toContain("85.5");

    for (const row of result.rows) {
      expect(Object.keys(row).sort()).toEqual(DRIVER_VIEW_KEYS);
    }
  });

  it("keeps the office's money on the same vehicle", async () => {
    const result = await history(vehicles.own, tokens.admin);

    expect(result.status, result.body).toBe(200);

    const review = result.rows.find(
      (row) => row.description === "Revisão do próprio",
    );

    expect(review).toMatchObject({
      total_amount: 300,
      supplier: { name: SUPPLIER_NAME },
      parts: [
        {
          description: PART_NAME,
          quantity: 2,
          unit_price: 85.5,
          discount_percentage: 10,
        },
      ],
    });
  });

  it("refuses an office profile without the maintenance key, with PERMISSION_DENIED", async () => {
    const result = await history(vehicles.colleague, tokens.noMaintenance);

    expect(result.status, result.body).toBe(403);
    expect(JSON.parse(result.body).code).toBe("PERMISSION_DENIED");
    expect(result.body).not.toContain("Embreagem do colega");
  });
});

/**
 * The history's `search` (14/11/2026), through the route: the web matched
 * the term against the pages it had loaded. The term compares only the
 * driver's view's fields; a match on the supplier or the total would tell
 * a driver which order the hidden value belongs to. The terms below carry
 * a character no generated id has, so a random uuid never matches them.
 */
describe("GET /service-order/search-service-order-by-vehicle — search", () => {
  it("never finds a driver's order by the supplier or the total", async () => {
    for (const term of [SUPPLIER_NAME, "Preço Alto", "300,00", "300.00"]) {
      const result = await history(vehicles.own, tokens.responsible, term);

      expect(result.status, result.body).toBe(200);
      expect(result.rows, term).toEqual([]);
    }
  });

  it("finds a driver's order by its description, responsible or branch", async () => {
    const description = await history(
      vehicles.own,
      tokens.responsible,
      "PNEUS",
    );

    expect(description.status, description.body).toBe(200);
    expect(description.rows.map((row) => row.description)).toEqual([
      "Pneus do próprio",
    ]);

    for (const term of ["Gestora", "Filial Pátio"]) {
      const result = await history(vehicles.own, tokens.responsible, term);

      expect(result.status, result.body).toBe(200);
      expect(result.rows.map((row) => row.description).sort(), term).toEqual([
        "Pneus do próprio",
        "Revisão do próprio",
      ]);

      for (const key of MONEY_KEYS) {
        expect(result.body, key).not.toContain(key);
      }
    }
  });

  it("does not let the office find by money either: one rule for the route", async () => {
    const result = await history(vehicles.own, tokens.admin, SUPPLIER_NAME);

    expect(result.status, result.body).toBe(200);
    expect(result.rows).toEqual([]);
  });

  it("refuses a term over 100 characters with 400 VALIDATION_ERROR", async () => {
    const result = await history(
      vehicles.own,
      tokens.responsible,
      "x".repeat(101),
    );

    expect(result.status, result.body).toBe(400);
    expect(JSON.parse(result.body).code).toBe("VALIDATION_ERROR");
  });

  it("still refuses a colleague's vehicle before any search", async () => {
    const result = await history(
      vehicles.colleague,
      tokens.substitute,
      "Embreagem",
    );

    expect(result.status, result.body).toBe(403);
    expect(result.body).not.toContain("Embreagem do colega");
  });
});
