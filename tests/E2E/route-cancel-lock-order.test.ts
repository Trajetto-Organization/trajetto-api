import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { container } from "tsyringe";

import { RouteRepository } from "@/modules/route/repositories/route-repository";
import { UpdateDeliveryStatusUseCase } from "@/modules/delivery/usecases/update-delivery-status/update-delivery-status-usecase";
import { AppError } from "@/shared/errors/AppError";

/**
 * A delivery resolved on a running route at the instant the route is
 * cancelled.
 *
 * The two transactions took the same rows in opposite orders. Resolving a
 * delivery updated the DELIVERY, then locked the ROUTE to settle its stop; the
 * cancellation updated the ROUTE, then its stops, then the DELIVERIES. When
 * they overlapped, each held what the other needed next: Postgres broke the
 * cycle after deadlock_timeout by aborting one of them with 40P01, and the
 * operator got a 500 for a click that was perfectly valid. No use case
 * retries P2034.
 *
 * The cancellation is driven by hand in two steps — first its route write,
 * then (once the other side is provably waiting) the rest of the real
 * transitionRoute — because that pause is the whole race, and a test that
 * cannot hold it open proves nothing.
 */
const prisma = new PrismaClient();
const repository = new RouteRepository(prisma);

const CARRIER = "018fde40-0000-7000-8000-00000000000a";
const ADMIN = "018fde40-0000-7000-8000-0000000000a1";
const DRIVER = "018fde40-0000-7000-8000-0000000000d1";
const SHIPPER = "018fde40-0000-7000-8000-0000000000f1";
const FUEL = "018fde40-0000-7000-8000-0000000000e1";

let reasonId = "";
let vehicleSeq = 0;

async function seedVehicle(): Promise<string> {
  vehicleSeq += 1;

  const vehicle = await prisma.vehicle.create({
    data: {
      description: "Caminhão",
      license_plate: `LCK1A${String(vehicleSeq).padStart(2, "0")}`,
      brand: "Volvo",
      model: "FH",
      acquisition_date: new Date(),
      fleet_type: "OWNED",
      current_mileage: 0,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: `lock-${randomUUID().slice(0, 8)}`,
      manufacturing_year: new Date(),
      model_year: new Date(),
      km_per_liter: 3,
      number_of_axles: 3,
      status: "ACTIVE",
      businessId: CARRIER,
      fuelTypeId: FUEL,
    },
  });

  return vehicle.id;
}

/** One delivery on a route that has left: IN_TRANSIT, on an open stop. */
async function runningRouteWithOneDelivery(): Promise<{
  routeId: string;
  deliveryId: string;
}> {
  const delivery = await prisma.delivery.create({
    data: {
      recipient_name: "Cliente",
      city: "São Paulo",
      uf: "SP",
      street: "Rua das Entregas",
      businessId: CARRIER,
      shipperId: SHIPPER,
    },
  });

  const route = await repository.createRoute({
    businessId: CARRIER,
    driverId: DRIVER,
    vehicleId: await seedVehicle(),
    scheduled_date: new Date(),
    deliveryIds: [delivery.id],
  });

  await repository.transitionRoute(route.id, CARRIER, {
    expectedStatus: "PLANNED",
    status: "RELEASED",
  });

  await repository.transitionRoute(route.id, CARRIER, {
    expectedStatus: "RELEASED",
    status: "IN_PROGRESS",
    started_at: new Date(),
  });

  return { routeId: route.id, deliveryId: delivery.id };
}

/** Until another backend of this database is waiting on a row lock. */
async function someoneWaitsOnALock(timeoutMs = 8_000): Promise<void> {
  const until = Date.now() + timeoutMs;

  while (Date.now() < until) {
    const [row] = await prisma.$queryRaw<Array<{ waiting: number }>>`
      SELECT count(*)::int AS "waiting"
      FROM pg_stat_activity
      WHERE "datname" = current_database()
        AND "wait_event_type" = 'Lock'
    `;

    if (row.waiting > 0) return;

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error("nobody ever waited on the route lock");
}

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora da Ordem de Lock",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(57000000000000 + Math.floor(Math.random() * 9000000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `lock-${randomUUID()}@exemplo.com.br`,
    },
  });

  await prisma.businessEntitlement.create({
    data: { businessId: CARRIER, module: "DELIVERIES", enabled: true },
  });

  await prisma.shipper.create({
    data: { id: SHIPPER, name: "Embarcador", businessId: CARRIER },
  });

  await prisma.fuelType.create({
    data: { id: FUEL, description: "Diesel", businessId: CARRIER },
  });

  await prisma.driver.create({
    data: {
      id: DRIVER,
      name: "João",
      birth_date: new Date("1990-01-01"),
      cnh: `cnh-${randomUUID().slice(0, 8)}`,
      cpf: `cpf-${randomUUID().slice(0, 8)}`,
      rg: `rg-${randomUUID().slice(0, 8)}`,
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

  await prisma.user.create({
    data: {
      id: ADMIN,
      name: "Despachante",
      email: `despacho-${randomUUID()}@exemplo.com.br`,
      password: "nao-usado",
      role: "BUSINESS_ADMIN",
      businessId: CARRIER,
    },
  });

  reasonId = (
    await prisma.statusChangeReason.create({
      data: { name: "Cliente ligou", businessId: CARRIER },
    })
  ).id;

  // Registers the tsyringe container the use case resolves from.
  await import("@/http");
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe("a delivery resolved while its route is being cancelled", () => {
  it("waits for the cancellation instead of deadlocking against it", async () => {
    const { routeId, deliveryId } = await runningRouteWithOneDelivery();

    const statusChange = container.resolve(UpdateDeliveryStatusUseCase);

    let resolveStarted: () => void = () => undefined;
    const cancellationHoldsTheRoute = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });

    const cancellation = prisma.$transaction(
      async (tx) => {
        // The cancellation's first write, on the route row — the same lock
        // transitionRoute's UPDATE takes.
        await tx.$executeRaw`
          UPDATE "route" SET "updated_at" = now()
          WHERE "id" = ${routeId} AND "businessId" = ${CARRIER}
        `;

        resolveStarted();

        // The other side is now inside its transaction and blocked on
        // something this one holds.
        await someoneWaitsOnALock();

        // ...and the rest of the real cancellation: stops, then deliveries.
        return repository.transitionRoute(
          routeId,
          CARRIER,
          {
            expectedStatus: "IN_PROGRESS",
            status: "CANCELLED",
            cancellation_reason: "Caminhão quebrou",
          },
          tx,
        );
      },
      { maxWait: 10_000, timeout: 20_000 },
    );

    await cancellationHoldsTheRoute;

    const resolution = statusChange
      .execute({
        userId: ADMIN,
        businessId: CARRIER,
        deliveryId,
        status: "DELIVERED",
        reasonId,
        note: "Entregue pelo escritório",
      })
      .then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );

    const [cancelled, resolved] = await Promise.allSettled([
      cancellation,
      resolution,
    ]);

    // The cancellation went through: it was never the one aborted.
    expect(
      cancelled.status,
      cancelled.status === "rejected" ? String(cancelled.reason) : "",
    ).toBe("fulfilled");

    // The status change lost the race honestly — a 409 the screen can explain
    // ("somebody else got there first") — or, had it won, succeeded. Never
    // the 500 a deadlock turned into.
    const outcome = (resolved as PromiseFulfilledResult<any>).value;

    if (!outcome.ok) {
      expect(outcome.error).toBeInstanceOf(AppError);
      expect(
        (outcome.error as AppError).statusCode,
        (outcome.error as AppError).message,
      ).toBeLessThan(500);
    }

    const route = await prisma.route.findUniqueOrThrow({
      where: { id: routeId },
    });
    const delivery = await prisma.delivery.findUniqueOrThrow({
      where: { id: deliveryId },
    });

    expect(route.status).toBe("CANCELLED");
    expect(delivery.status).toBe("PENDING");
  }, 60_000);
});
