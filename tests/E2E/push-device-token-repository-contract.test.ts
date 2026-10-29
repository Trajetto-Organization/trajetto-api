import { afterAll, beforeAll, describe } from "vitest";

import { PushDeviceTokenRepository } from "@/modules/notification/repositories/push-device-token-repository";
import { InMemoryPushDeviceTokenRepository } from "@/modules/notification/repositories/in-memory/in-memory-push-device-token-repository";

import {
  PUSH_FIXTURE as F,
  pushDeviceTokenRepositoryContract,
  type PushDeviceHarness,
} from "../contract/repositories/push-device-token.contract";
import { KINDS, type Kind } from "../contract/support";
import { seedBusiness, seedUser } from "../contract/seed";
import { createPrismaClient } from "@/shared/database/database-client";

/** Decision 13.2: the push device contract against Postgres and the twin. */
const prisma = createPrismaClient();
const memory = new InMemoryPushDeviceTokenRepository(new Set([F.ana, F.bia]));

const harnesses: Record<Kind, PushDeviceHarness> = {
  prisma: {
    kind: "prisma",
    repo: new PushDeviceTokenRepository(prisma),
    rows: () =>
      prisma.pushDeviceToken.findMany({
        select: {
          token: true,
          platform: true,
          userId: true,
          session_family_id: true,
        },
        orderBy: { token: "asc" },
      }),
  },
  "in-memory": {
    kind: "in-memory",
    repo: memory,
    rows: async () =>
      memory.devices
        .map(({ token, platform, userId, session_family_id }) => ({
          token,
          platform,
          userId,
          session_family_id,
        }))
        .sort((a, b) => (a.token < b.token ? -1 : 1)),
  },
};

beforeAll(async () => {
  await seedBusiness(prisma, F.A, 1);
  await seedUser(prisma, F.A, 1, { id: F.ana });
  await seedUser(prisma, F.A, 2, { id: F.bia });
});

afterAll(async () => {
  await prisma.$disconnect();
});

for (const kind of KINDS) {
  describe(`push device token repository (${kind})`, () => {
    pushDeviceTokenRepositoryContract(() => harnesses[kind]);
  });
}
