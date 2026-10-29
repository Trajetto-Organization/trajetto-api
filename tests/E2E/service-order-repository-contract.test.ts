import { afterAll, beforeAll, describe } from "vitest";

import { ServiceOrderRepository } from "@/modules/service-order/repositories/service-order-repository";
import { InMemoryServiceOrderRepository } from "@/modules/service-order/repositories/in-memory/in-memory-service-order-repository";

import {
  SERVICE_ORDER_FIXTURE as F,
  SERVICE_ORDER_SEED,
  serviceOrderRepositoryContract,
  type ServiceOrderHarness,
} from "../contract/repositories/service-order.contract";
import { KINDS, minute, type Kind } from "../contract/support";
import {
  seedBranch,
  seedBusiness,
  seedUser,
  seedVehicle,
} from "../contract/seed";
import { createPrismaClient } from "@/shared/database/database-client";

/** Decision 13.2: the service order contract against Postgres and the twin. */
const prisma = createPrismaClient();
const prismaRepo = new ServiceOrderRepository(prisma);
const memory = new InMemoryServiceOrderRepository();

const ids: Partial<Record<Kind, Map<string, string>>> = {};

const harnessOf = (kind: Kind): ServiceOrderHarness => ({
  kind,
  repo: kind === "prisma" ? prismaRepo : memory,
  id: (key) => {
    const id = ids[kind]?.get(key);
    if (!id) throw new Error(`no service order ${key}`);
    return id;
  },
});

const harnesses: Record<Kind, ServiceOrderHarness> = {
  prisma: harnessOf("prisma"),
  "in-memory": harnessOf("in-memory"),
};

beforeAll(async () => {
  await seedBusiness(prisma, F.A, 1);
  await seedBusiness(prisma, F.B, 2);
  await seedBranch(prisma, F.A, 1, F.branchA);
  await seedBranch(prisma, F.B, 2, F.branchB);
  const userA = await seedUser(prisma, F.A, 1, { id: F.userA });
  const userB = await seedUser(prisma, F.B, 2, { id: F.userB });
  await seedVehicle(prisma, F.A, F.plateA, { id: F.vehicleA });
  await seedVehicle(prisma, F.B, F.plateB, { id: F.vehicleB });

  memory.vehicles.set(F.vehicleA, {
    license_plate: F.plateA,
    description: `Caminhão ${F.plateA}`,
  });
  memory.vehicles.set(F.vehicleB, {
    license_plate: F.plateB,
    description: `Caminhão ${F.plateB}`,
  });
  memory.userNames.set(F.userA, userA.name);
  memory.userNames.set(F.userB, userB.name);

  for (const kind of KINDS) {
    const repo = harnesses[kind].repo;
    const created = new Map<string, string>();

    for (const row of SERVICE_ORDER_SEED) {
      const stored = await repo.createServiceOrder(row.data);
      created.set(row.key, stored.id);

      if (kind === "prisma") {
        await prisma.serviceOrder.update({
          where: { id: stored.id },
          data: { created_at: minute(row.minute) },
        });
      } else {
        memory.serviceOrders.find(
          (entry) => entry.id === stored.id,
        )!.created_at = minute(row.minute);
      }
    }

    ids[kind] = created;
  }
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe.each(KINDS)("service order repository (%s)", (kind) => {
  serviceOrderRepositoryContract(() => harnesses[kind]);
});
