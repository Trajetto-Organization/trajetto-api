import { afterAll, beforeAll, describe } from "vitest";

import { BusinessRepository } from "@/modules/business/repositories/business-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";
import type { Business } from "@/modules/business/dtos/business-dto";

import {
  BUSINESSES,
  businessRepositoryContract,
  type BusinessHarness,
} from "../contract/repositories/business.contract";
import { clone, KINDS, type Kind } from "../contract/support";
import { seedBranch, seedDriver, seedUser } from "../contract/seed";
import { createPrismaClient } from "@/shared/database/database-client";

/** Decision 13.2: the business contract against Postgres and the twin. */
const prisma = createPrismaClient();

const memory = new InMemoryBusinessRepository();
let seeded = 0;

const harnesses: Record<Kind, BusinessHarness> = {
  prisma: {
    kind: "prisma",
    repo: new BusinessRepository(prisma),
    async addDependents(businessId) {
      seeded += 1;
      await seedBranch(prisma, businessId, 900 + seeded);
      await seedUser(prisma, businessId, 900 + seeded);
      await seedDriver(prisma, businessId, 900 + seeded);
    },
  },
  "in-memory": {
    kind: "in-memory",
    repo: memory,
    async addDependents(businessId) {
      memory.dependents.branches.push({ businessId });
      memory.dependents.users.push({ businessId });
      memory.dependents.drivers.push({ businessId });
    },
  },
};

beforeAll(async () => {
  for (const { id, is_active, created_at, ...data } of BUSINESSES) {
    const row = await prisma.business.create({
      data: { ...data, id, is_active, created_at },
    });

    // The twin holds exactly what Postgres stored, defaults included.
    memory.business.push(clone(row) as Business);
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe.each(KINDS)("business repository (%s)", (kind) => {
  businessRepositoryContract(() => harnesses[kind]);
});
