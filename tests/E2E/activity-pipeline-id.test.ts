import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";
import { v7 as uuidV7 } from "uuid";

import { ActivityRepository } from "@/modules/activity/repositories/activity-repository";
import { createPrismaClient } from "@/shared/database/database-client";

import {
  seedFleetDriver,
  type FleetDriverSeed,
} from "./support/fleet-driver-seed";

/**
 * The pipeline's activity once the unique on deliveryId is gone
 * (plano-escala F2-15).
 *
 * The activity trail becomes a table partitioned by month on its id in
 * wave 11 (F2-18), and the global unique on activity."deliveryId" cannot
 * stay there. This file drops it from its own database, as that release
 * will, and proves the promise still holds through the primary key: the
 * notification_delivery's id IS the activity's id, so five workers
 * recording one delivery at once write one row, and a row the previous
 * image wrote under a random id is still found by deliveryId instead of
 * gaining a twin.
 */
const prisma = createPrismaClient();
const otherConnection = createPrismaClient();

const CARRIER = "019a8f20-0000-7000-8000-00000000000a";

let seed: FleetDriverSeed;

const entry = (deliveryId: string) => ({
  type: "Entrega",
  action: "update",
  entityId: randomUUID(),
  description: "Entrega saiu para rota",
  status: "Atualizado",
  performedBy: seed.driverUserId,
  businessId: CARRIER,
  deliveryId,
});

beforeAll(async () => {
  seed = await seedFleetDriver(prisma, {
    businessId: CARRIER,
    cnpj: "55888990000191",
  });

  // What the partitioned trail of wave 11 will not have.
  await prisma.$executeRawUnsafe(
    `DROP INDEX IF EXISTS "activity_deliveryId_key"`,
  );
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
  await otherConnection.$disconnect();
}, 60_000);

describe("without the unique on deliveryId", () => {
  it("is one row, under the delivery's id, however many workers record it at once", async () => {
    const deliveryId = uuidV7();

    const results = await Promise.all([
      new ActivityRepository(prisma).createActivity(entry(deliveryId)),
      new ActivityRepository(otherConnection).createActivity(entry(deliveryId)),
      new ActivityRepository(prisma).createActivity(entry(deliveryId)),
      new ActivityRepository(otherConnection).createActivity(entry(deliveryId)),
    ]);

    expect(new Set(results.map((row) => row.id))).toEqual(
      new Set([deliveryId]),
    );
    expect(await prisma.activity.count({ where: { deliveryId } })).toBe(1);
  });

  it("finds the row the previous image wrote under a random id", async () => {
    const deliveryId = uuidV7();

    const legacy = await prisma.activity.create({ data: entry(deliveryId) });

    const recorded = await new ActivityRepository(prisma).createActivity(
      entry(deliveryId),
    );

    expect(recorded.id).toBe(legacy.id);
    expect(await prisma.activity.count({ where: { deliveryId } })).toBe(1);
  });
});
