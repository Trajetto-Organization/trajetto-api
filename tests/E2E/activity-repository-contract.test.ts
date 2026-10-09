import { afterAll, beforeAll, describe } from "vitest";

import { PrismaClient } from "@prisma/client";

import { ActivityRepository } from "@/modules/activity/repositories/activity-repository";
import { InMemoryActivityRepository } from "@/modules/activity/repositories/in-memory/in-memory-activity-repository";

import {
  ACTIVITY_FIXTURE as F,
  ACTIVITY_SEED,
  activityRepositoryContract,
  type ActivityHarness,
} from "../contract/repositories/activity.contract";
import { KINDS, type Kind } from "../contract/support";
import { seedBusiness, seedUser } from "../contract/seed";

/** Decision 13.2: the activity contract against Postgres and the twin. */
const prisma = new PrismaClient();
const memory = new InMemoryActivityRepository();

const harnesses: Record<Kind, ActivityHarness> = {
  prisma: { kind: "prisma", repo: new ActivityRepository(prisma) },
  "in-memory": { kind: "in-memory", repo: memory },
};

const PEOPLE = [
  {
    id: F.adminA,
    role: "BUSINESS_ADMIN" as const,
    businessId: F.A as string | null,
    n: 1,
  },
  {
    id: F.adminB,
    role: "BUSINESS_ADMIN" as const,
    businessId: F.B as string | null,
    n: 2,
  },
  { id: F.master, role: "MASTER" as const, businessId: null, n: 3 },
];

beforeAll(async () => {
  const a = await seedBusiness(prisma, F.A, 1);
  const b = await seedBusiness(prisma, F.B, 2);

  memory.businesses.set(F.A, { corporate_reason: a.corporate_reason });
  memory.businesses.set(F.B, { corporate_reason: b.corporate_reason });

  for (const person of PEOPLE) {
    const user = await seedUser(prisma, person.businessId, person.n, {
      id: person.id,
      role: person.role,
    });

    memory.users.set(person.id, {
      role: person.role,
      businessId: person.businessId,
      driverId: null,
      name: user.name,
      email: user.email,
    });
  }

  // Recent enough for the 30-day window in any zone.
  const now = Date.now();

  for (const [index, row] of ACTIVITY_SEED.entries()) {
    const created_at = new Date(now - (ACTIVITY_SEED.length - index) * 60_000);
    const fields = {
      ...row,
      action: "update",
      entityId: row.id,
      status: "Completo",
      visibilityLevel: "COMPANY",
      performingUserRole: PEOPLE.find(
        (person) => person.id === row.performedBy,
      )!.role,
      created_at,
    };

    await prisma.activity.create({ data: fields });
    memory.addActivity(fields);
  }
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe.each(KINDS)("activity repository (%s)", (kind) => {
  activityRepositoryContract(() => harnesses[kind]);
});
