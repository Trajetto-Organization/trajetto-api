import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";

import { RouteRepository } from "@/modules/route/repositories/route-repository";
import { stopOutcomeForDelivery } from "@/shared/route/route-rules";

/**
 * "Back to pending" for a delivery whose stop is on a route that has NOT left
 * (IDEMP-11 review), against Postgres.
 *
 * On a running route IN_TRANSIT → PENDING cancels the stop and releases the
 * delivery. On a plan it is the dispatcher undoing a mistaken "Em rota": the
 * stop and the shadow stay, because PENDING on a released route is the state
 * the document had before the mistake. Only a real outcome (delivered,
 * failed, cancelled) takes a stop off a plan.
 */
const prisma = new PrismaClient();
const repository = new RouteRepository(prisma);

const CARRIER = "biz-unstarted-pending";
const DRIVER = "drv-unstarted-pending";
const SHIPPER = "shp-unstarted-pending";
const VEHICLE = "veh-unstarted-pending";

let deliverySeq = 0;

async function seedDelivery(): Promise<string> {
  deliverySeq += 1;

  const id = `dlv-unstarted-${deliverySeq}`;

  await prisma.delivery.create({
    data: {
      id,
      code: `NF-UNSTARTED-${deliverySeq}`,
      recipient_name: `Cliente ${deliverySeq}`,
      city: "São Paulo",
      uf: "SP",
      street: "Rua das Entregas",
      businessId: CARRIER,
      shipperId: SHIPPER,
    },
  });

  return id;
}

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora Plano",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua das Transportadoras",
      address_number: "1",
      cnpj: "11222333000288",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: "plano@exemplo.com.br",
    },
  });

  await prisma.shipper.create({
    data: { id: SHIPPER, name: "Embarcador", businessId: CARRIER },
  });

  await prisma.driver.create({
    data: {
      id: DRIVER,
      name: "João",
      birth_date: new Date("1990-01-01"),
      cnh: "cnh-unstarted-pending",
      cpf: "cpf-unstarted-pending",
      rg: "rg-unstarted-pending",
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

  await prisma.fuelType.create({
    data: { id: "ft-unstarted-pending", description: "Diesel", businessId: CARRIER },
  });

  await prisma.vehicle.create({
    data: {
      id: VEHICLE,
      description: "Caminhão",
      license_plate: "UNS1A01",
      brand: "Volvo",
      model: "FH",
      acquisition_date: new Date(),
      fleet_type: "OWNED",
      current_mileage: 0,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: "renavam-unstarted-1",
      manufacturing_year: new Date(),
      model_year: new Date(),
      km_per_liter: 3,
      number_of_axles: 3,
      status: "ACTIVE",
      businessId: CARRIER,
      fuelTypeId: "ft-unstarted-pending",
    },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** The override the use case makes, in its order: route, delivery, stop. */
async function override(
  deliveryId: string,
  from: "IN_TRANSIT" | "PENDING",
  to: "PENDING" | "CANCELLED",
): Promise<void> {
  const outcome = stopOutcomeForDelivery(to, new Date(), from)!;

  await prisma.$transaction(async (tx) => {
    await repository.lockRouteOfOpenStop(deliveryId, CARRIER, tx);

    await tx.delivery.update({
      where: { id: deliveryId },
      data: { status: to },
    });

    await repository.settleStopForDelivery(deliveryId, CARRIER, outcome, tx);
  });
}

describe("back to pending on a route that has not left", () => {
  it("keeps the stop and the driver", async () => {
    const corrected = await seedDelivery();
    const other = await seedDelivery();

    const route = await repository.createRoute({
      businessId: CARRIER,
      driverId: DRIVER,
      vehicleId: VEHICLE,
      scheduled_date: new Date(),
      deliveryIds: [corrected, other],
    });

    await repository.transitionRoute(route.id, CARRIER, {
      expectedStatus: "PLANNED",
      status: "RELEASED",
    });

    // The mistaken "Em rota" on the panel, then its correction.
    await prisma.delivery.update({
      where: { id: corrected },
      data: { status: "IN_TRANSIT" },
    });

    await override(corrected, "IN_TRANSIT", "PENDING");

    const stops = await prisma.routeStop.findMany({
      where: { deliveryId: corrected },
    });

    // Before the fix: deleted — the document silently left the plan.
    expect(stops, "a parada saiu do plano").toHaveLength(1);
    expect(stops[0].routeId).toBe(route.id);
    expect(stops[0].status).toBe("PENDING");

    const row = await prisma.delivery.findUniqueOrThrow({
      where: { id: corrected },
    });

    expect(row.status).toBe("PENDING");
    expect(row.driverId).toBe(DRIVER);
    expect(row.vehicleId).toBe(VEHICLE);
  }, 30_000);

  it("still takes a cancelled delivery off the plan", async () => {
    const cancelled = await seedDelivery();
    const kept = await seedDelivery();

    const route = await repository.createRoute({
      businessId: CARRIER,
      driverId: DRIVER,
      vehicleId: VEHICLE,
      scheduled_date: new Date(),
      deliveryIds: [cancelled, kept],
    });

    await repository.transitionRoute(route.id, CARRIER, {
      expectedStatus: "PLANNED",
      status: "RELEASED",
    });

    await override(cancelled, "PENDING", "CANCELLED");

    expect(
      await prisma.routeStop.count({ where: { deliveryId: cancelled } }),
    ).toBe(0);
    expect(await prisma.routeStop.count({ where: { routeId: route.id } })).toBe(
      1,
    );
  }, 30_000);
});
