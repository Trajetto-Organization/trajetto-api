import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";

import {
  seedBranch,
  seedCarrier,
  seedUser,
  seedVehicle,
} from "./support/fleet-maint-seed";

/**
 * Deleting a service order, and finishing one at the same mileage, against
 * Postgres.
 *
 * FLEET-SO-1: the delete had no guard. A bill pointing at the order lost its
 * origin (the foreign key is SET NULL), and a finished order had already
 * moved the vehicle's odometer, which the delete does not move back.
 * FLEET-SO-4: finishing an order demanded a mileage strictly above the
 * odometer, so a vehicle that stood in the workshop could not be closed.
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018fe300-0000-7000-8000-00000000000a";
const OTHER = "018fe300-0000-7000-8000-00000000000b";

let adminId = "";
let adminToken = "";
let otherToken = "";
let branchId = "";
let vehicleId = "";
let otherOrderId = "";

async function order(
  data: Partial<{
    completion_date: Date | null;
    vehicle: string;
  }> = {},
): Promise<string> {
  const created = await prisma.serviceOrder.create({
    data: {
      description: "Troca de pastilhas",
      maintenance_type: "EXTERNAL",
      total_amount: 500,
      completion_date: data.completion_date ?? null,
      businessId: CARRIER,
      branchId,
      vehicleId: data.vehicle ?? vehicleId,
      responsibleUserId: adminId,
    },
  });

  return created.id;
}

const remove = (id: string, businessId = CARRIER, token = adminToken) =>
  app.inject({
    method: "DELETE",
    url: `/service-order/delete-service-order/${id}/business/${businessId}`,
    headers: { authorization: `Bearer ${token}` },
  });

beforeAll(async () => {
  await seedCarrier(prisma, CARRIER);
  await seedCarrier(prisma, OTHER);

  branchId = await seedBranch(prisma, CARRIER, "Filial Oficina");
  vehicleId = await seedVehicle(prisma, CARRIER, {
    plate: "PQR4S44",
    branchId,
    mileage: 42_000,
  });

  const admin = await seedUser(prisma, "Gestora", "BUSINESS_ADMIN", CARRIER);
  adminId = admin.id;
  adminToken = admin.token;

  const other = await seedUser(prisma, "Outro", "BUSINESS_ADMIN", OTHER);
  otherToken = other.token;

  const otherBranch = await seedBranch(prisma, OTHER, "Filial da Outra");
  const otherVehicle = await seedVehicle(prisma, OTHER, {
    plate: "XYZ5W55",
    branchId: otherBranch,
  });

  otherOrderId = (
    await prisma.serviceOrder.create({
      data: {
        maintenance_type: "INTERNAL",
        total_amount: 100,
        businessId: OTHER,
        branchId: otherBranch,
        vehicleId: otherVehicle,
        responsibleUserId: other.id,
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

describe("DELETE /service-order/delete-service-order — the guard (FLEET-SO-1)", () => {
  it("refuses a finished order and keeps it", async () => {
    const id = await order({ completion_date: new Date() });

    const response = await remove(id);

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "SERVICE_ORDER_COMPLETED" });
    expect(
      await prisma.serviceOrder.findUnique({ where: { id } }),
    ).not.toBeNull();
  });

  it("refuses an order a bill points at, and the bill keeps its origin", async () => {
    const id = await order();

    const bill = await prisma.accountPayable.create({
      data: {
        due_date: new Date(),
        amount: 500,
        amount_paid: 500,
        payment_date: new Date(),
        businessId: CARRIER,
        branchId,
        serviceOrderId: id,
        registrationUserId: adminId,
      },
    });

    const response = await remove(id);

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: "SERVICE_ORDER_HAS_ACCOUNTS_PAYABLE",
    });
    expect(response.json().message).toContain("1 conta(s) a pagar");

    const kept = await prisma.accountPayable.findUniqueOrThrow({
      where: { id: bill.id },
    });

    expect(kept.serviceOrderId).toBe(id);
  });

  it("deletes an open order with its parts and says how many went with it", async () => {
    const id = await order();

    const part = await prisma.part.create({
      data: {
        description: `Pastilha ${id.slice(-4)}`,
        unit_price: 80,
        businessId: CARRIER,
      },
    });

    await prisma.serviceOrderPart.createMany({
      data: [
        {
          serviceOrderId: id,
          partId: part.id,
          unit_price: 80,
          quantity: 4,
          businessId: CARRIER,
        },
        {
          serviceOrderId: id,
          partId: part.id,
          unit_price: 10,
          quantity: 1,
          businessId: CARRIER,
        },
      ],
    });

    const response = await remove(id);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ partsRemoved: 2 });
    expect(
      await prisma.serviceOrderPart.count({ where: { serviceOrderId: id } }),
    ).toBe(0);
    // The catalog keeps the part.
    expect(
      await prisma.part.findUnique({ where: { id: part.id } }),
    ).not.toBeNull();
  });

  it("sees a bill linked while the delete waits for its lock", async () => {
    const id = await order();

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    // A bill inserted and not yet committed holds a key lock on the order;
    // the delete's FOR UPDATE waits for it and then counts it.
    let inserted!: () => void;
    const insertedSignal = new Promise<void>((resolve) => {
      inserted = resolve;
    });

    const billing = prisma.$transaction(
      async (tx) => {
        await tx.accountPayable.create({
          data: {
            due_date: new Date(),
            amount: 500,
            businessId: CARRIER,
            branchId,
            serviceOrderId: id,
            registrationUserId: adminId,
          },
        });

        inserted();
        await held;
      },
      { timeout: 20_000 },
    );

    await insertedSignal;

    const deleting = remove(id);

    // Give the delete time to reach the lock before the bill commits.
    await new Promise((resolve) => setTimeout(resolve, 400));
    release();
    await billing;

    const response = await deleting;

    expect(response.statusCode).toBe(409);
    expect(
      await prisma.serviceOrder.findUnique({ where: { id } }),
    ).not.toBeNull();
    expect(
      await prisma.accountPayable.count({ where: { serviceOrderId: id } }),
    ).toBe(1);
  });

  it("answers 404 for an order that does not exist", async () => {
    const response = await remove("018fe300-0000-7000-8000-0000000000ff");

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: "SERVICE_ORDER_NOT_FOUND" });
  });

  it("never deletes another company's order, and answers it like a missing one", async () => {
    // Through this company's path: the same 404 as an order that exists
    // nowhere (a 403 "não pertence" confirmed the id, decision 11.3).
    const foreign = await remove(otherOrderId);
    const missing = await remove("018fe300-0000-7000-8000-0000000000fe");

    expect(foreign.statusCode).toBe(404);
    expect(foreign.json()).toEqual(missing.json());

    // Through the other company's path the tenant gate refuses the company.
    expect((await remove(otherOrderId, OTHER)).statusCode).toBe(403);
    expect((await remove(otherOrderId, OTHER, otherToken)).statusCode).toBe(
      200,
    );
  });
});

describe("finishing an order at the same mileage (FLEET-SO-4)", () => {
  const body = (extra: Record<string, unknown>) => ({
    date: new Date("2026-09-20T12:00:00Z").toISOString(),
    maintenance_type: "INTERNAL",
    total_amount: 350,
    current_mileage_at_service: 42_000,
    maintenance_interval_km_at_service: 10_000,
    last_maintenance_mileage_at_service: 32_000,
    vehicleId,
    responsibleUserId: adminId,
    branchId,
    created_from: "WEB_DASHBOARD",
    ...extra,
  });

  it("creates an order already finished at the odometer's reading", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/service-order/create-service-order/${CARRIER}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: body({
        completion_date: new Date("2026-09-21T12:00:00Z").toISOString(),
        new_mileage_after_service: 42_000,
      }),
    });

    expect(response.statusCode, response.body).toBe(201);

    const vehicle = await prisma.vehicle.findUniqueOrThrow({
      where: { id: vehicleId },
    });

    // The odometer stays; the maintenance is recorded at that reading.
    expect(vehicle.current_mileage).toBe(42_000);
    expect(vehicle.last_maintenance_mileage).toBe(42_000);
    expect(vehicle.last_maintenance_date?.toISOString()).toBe(
      "2026-09-21T12:00:00.000Z",
    );
  });

  it("finishes an open order at the same reading", async () => {
    const id = await order();

    // After the order's own date (it was opened just now).
    const finishedAt = new Date(Date.now() + 60_000);

    const response = await app.inject({
      method: "PATCH",
      url: `/service-order/update-service-order/${id}/business/${CARRIER}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        completion_date: finishedAt.toISOString(),
        new_mileage_after_service: 42_000,
      },
    });

    expect(response.statusCode, response.body).toBe(200);

    const vehicle = await prisma.vehicle.findUniqueOrThrow({
      where: { id: vehicleId },
    });

    expect(vehicle.current_mileage).toBe(42_000);
    expect(vehicle.last_maintenance_date?.toISOString()).toBe(
      finishedAt.toISOString(),
    );
  });

  it("still refuses a reading behind the odometer", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/service-order/create-service-order/${CARRIER}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: body({
        current_mileage_at_service: 41_000,
        completion_date: new Date("2026-09-21T12:00:00Z").toISOString(),
        new_mileage_after_service: 41_500,
      }),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: "SERVICE_ORDER_MILEAGE_BEHIND",
    });

    const vehicle = await prisma.vehicle.findUniqueOrThrow({
      where: { id: vehicleId },
    });

    expect(vehicle.current_mileage).toBe(42_000);
  });
});

describe("editing a finished order after the odometer moved on", () => {
  /**
   * The stored reading of a finished order was judged again against the
   * vehicle's odometer on every edit. After the next fuel-up moved the
   * odometer past it, every save of that order answered 400
   * SERVICE_ORDER_MILEAGE_BEHIND — and the delete guard refuses a finished
   * order and sends the user to edit it. The order was frozen.
   */
  let truck = "";
  let orderId = "";

  const update = (payload: Record<string, unknown>) =>
    app.inject({
      method: "PATCH",
      url: `/service-order/update-service-order/${orderId}/business/${CARRIER}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload,
    });

  // What the web edit form posts: every field, the stored reading included.
  const formPayload = (extra: Record<string, unknown>) => ({
    date: new Date("2026-09-20T12:00:00Z").toISOString(),
    completion_date: new Date("2026-09-21T12:00:00Z").toISOString(),
    maintenance_type: "EXTERNAL",
    total_amount: 500,
    description: "Troca de pastilhas",
    current_mileage_at_service: 44_000,
    maintenance_interval_km_at_service: 10_000,
    last_maintenance_mileage_at_service: 34_000,
    new_mileage_after_service: 45_000,
    vehicleId: truck,
    branchId,
    responsibleUserId: adminId,
    ...extra,
  });

  beforeAll(async () => {
    truck = await seedVehicle(prisma, CARRIER, {
      plate: "FRZ6T66",
      branchId,
      mileage: 44_000,
    });
    orderId = await order({ vehicle: truck });

    // Opened at 44 000 km: the snapshot a correction is judged against.
    await prisma.serviceOrder.update({
      where: { id: orderId },
      data: { current_mileage_at_service: 44_000 },
    });

    // Finished at 45 000 km: the odometer follows.
    const finished = await update({
      date: new Date("2026-09-20T12:00:00Z").toISOString(),
      completion_date: new Date("2026-09-21T12:00:00Z").toISOString(),
      new_mileage_after_service: 45_000,
    });

    expect(finished.statusCode, finished.body).toBe(200);

    // The next fuel-up moves the odometer on.
    await prisma.vehicle.update({
      where: { id: truck },
      data: { current_mileage: 50_000 },
    });
  });

  it("saves a change of description with the stored reading unchanged", async () => {
    const response = await update(
      formPayload({ description: "Troca de pastilhas e discos" }),
    );

    expect(response.statusCode, response.body).toBe(200);

    const saved = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: orderId },
    });
    const vehicle = await prisma.vehicle.findUniqueOrThrow({
      where: { id: truck },
    });

    expect(saved.description).toBe("Troca de pastilhas e discos");
    expect(saved.new_mileage_after_service).toBe(45_000);
    // Neither the odometer nor the last maintenance is touched by the edit.
    expect(vehicle.current_mileage).toBe(50_000);
    expect(vehicle.last_maintenance_mileage).toBe(45_000);
  });

  it("corrects the reading behind the odometer: the last maintenance follows, the odometer stays", async () => {
    // Judged against the live odometer, this honest correction was refused
    // (400 SERVICE_ORDER_MILEAGE_BEHIND): only a false value above 50 000
    // could be saved.
    const response = await update(
      formPayload({ new_mileage_after_service: 45_500 }),
    );

    expect(response.statusCode, response.body).toBe(200);

    const saved = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: orderId },
    });
    const vehicle = await prisma.vehicle.findUniqueOrThrow({
      where: { id: truck },
    });

    expect(saved.new_mileage_after_service).toBe(45_500);
    expect(vehicle.current_mileage).toBe(50_000);
    expect(vehicle.last_maintenance_mileage).toBe(45_500);
  });

  it("still refuses a correction behind the order's opening reading", async () => {
    const response = await update(
      formPayload({ new_mileage_after_service: 43_000 }),
    );

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: "SERVICE_ORDER_MILEAGE_BEHIND",
    });
    expect(response.json().message).toContain("abertura da ordem (44000 km)");

    const saved = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: orderId },
    });

    expect(saved.new_mileage_after_service).toBe(45_500);
  });

  it("leaves a later maintenance alone, and refuses passing the odometer then", async () => {
    // A later order, finished at 52 000 km, becomes the vehicle's last maintenance.
    const laterId = await order({ vehicle: truck });
    const later = await app.inject({
      method: "PATCH",
      url: `/service-order/update-service-order/${laterId}/business/${CARRIER}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        date: new Date("2026-09-24T12:00:00Z").toISOString(),
        completion_date: new Date("2026-09-25T12:00:00Z").toISOString(),
        new_mileage_after_service: 52_000,
      },
    });

    expect(later.statusCode, later.body).toBe(200);

    const corrected = await update(
      formPayload({ new_mileage_after_service: 46_000 }),
    );

    expect(corrected.statusCode, corrected.body).toBe(200);

    let vehicle = await prisma.vehicle.findUniqueOrThrow({
      where: { id: truck },
    });

    expect(vehicle.current_mileage).toBe(52_000);
    expect(vehicle.last_maintenance_mileage).toBe(52_000);

    const ahead = await update(
      formPayload({ new_mileage_after_service: 53_000 }),
    );

    expect(ahead.statusCode).toBe(400);
    expect(ahead.json()).toMatchObject({ code: "SERVICE_ORDER_MILEAGE_AHEAD" });

    const saved = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: orderId },
    });
    vehicle = await prisma.vehicle.findUniqueOrThrow({ where: { id: truck } });

    expect(saved.new_mileage_after_service).toBe(46_000);
    expect(vehicle.current_mileage).toBe(52_000);
  });
});
