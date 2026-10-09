import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { PrismaClient } from "@prisma/client";

/**
 * The maintenance lists (service orders, parts, service order parts) take at
 * most two pool connections at a time: the page, and the counts behind the
 * cards and filters one after another (decision 8.8's budget, the same as
 * tests/E2E/connection-fan-out). Measured by wrapping the application's own
 * client, so the repositories run exactly the code production runs.
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

import database from "@/../infra/database";

import { ServiceOrderRepository } from "@/modules/service-order/repositories/service-order-repository";
import { PartRepository } from "@/modules/part/repositories/part-repository";
import { ServiceOrderPartRepository } from "@/modules/service-order-part/repositories/service-order-part-repository";

import {
  seedBranch,
  seedCarrier,
  seedSupplier,
  seedUser,
  seedVehicle,
} from "./support/fleet-maint-seed";

const prisma = new PrismaClient();

const CARRIER = "018fe500-0000-7000-8000-00000000000a";
const BUDGET = 2;

async function peakOf<T>(run: () => Promise<T>): Promise<{ peak: number; result: T }> {
  pool.inFlight = 0;
  pool.peak = 0;

  const result = await run();

  return { peak: pool.peak, result };
}

beforeAll(async () => {
  await seedCarrier(prisma, CARRIER);

  const branchId = await seedBranch(prisma, CARRIER, "Filial");
  const vehicleId = await seedVehicle(prisma, CARRIER, { plate: "PQR8S88", branchId });
  const supplierId = await seedSupplier(prisma, CARRIER, "Oficina");
  const admin = await seedUser(prisma, "Gestora", "BUSINESS_ADMIN", CARRIER);

  const part = await prisma.part.create({
    data: { description: "Filtro", unit_price: 10, businessId: CARRIER, supplierId },
  });

  for (const completed of [false, true, false]) {
    const order = await prisma.serviceOrder.create({
      data: {
        maintenance_type: completed ? "EXTERNAL" : "INTERNAL",
        total_amount: 100,
        completion_date: completed ? new Date() : null,
        businessId: CARRIER,
        branchId,
        vehicleId,
        responsibleUserId: admin.id,
      },
    });

    await prisma.serviceOrderPart.create({
      data: {
        serviceOrderId: order.id,
        partId: part.id,
        unit_price: 10,
        quantity: 2,
        businessId: CARRIER,
      },
    });
  }
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
  await (database as unknown as PrismaClient).$disconnect();
});

describe("one maintenance list, at most two connections", () => {
  it("the service orders, with the cards and the filter options", async () => {
    const { peak, result } = await peakOf(() =>
      new ServiceOrderRepository().listServiceOrders({
        businessId: CARRIER,
        page: 1,
        pageSize: 10,
        statuses: ["open"],
      }),
    );

    expect(peak, `as ordens de serviço ocuparam ${peak} conexões`).toBeLessThanOrEqual(BUDGET);
    expect(result.data).toHaveLength(2);
    expect(result.branchCounts).toHaveLength(1);
  });

  it("the parts catalog", async () => {
    const { peak, result } = await peakOf(() =>
      new PartRepository().listParts({ businessId: CARRIER, page: 1, pageSize: 10 }),
    );

    expect(peak, `as peças ocuparam ${peak} conexões`).toBeLessThanOrEqual(BUDGET);
    expect(result.data).toHaveLength(1);
  });

  it("the service order parts, with the SQL cards", async () => {
    const { peak, result } = await peakOf(() =>
      new ServiceOrderPartRepository().listServiceOrderParts({
        businessId: CARRIER,
        page: 1,
        pageSize: 10,
      }),
    );

    expect(peak, `as peças das ordens ocuparam ${peak} conexões`).toBeLessThanOrEqual(BUDGET);
    expect(result.aggregate).toEqual({ count: 3, withDiscount: 0, totalValue: 60 });
  });
});
