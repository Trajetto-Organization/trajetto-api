import { afterAll, beforeAll, describe } from "vitest";

import { BusinessSettingsRepository } from "@/modules/business/repositories/business-settings-repository";
import { InMemoryBusinessSettingsRepository } from "@/modules/business/repositories/in-memory/in-memory-business-settings-repository";

import {
  ALFA,
  BETA,
  GAMMA,
  businessSettingsRepositoryContract,
  type BusinessSettingsHarness,
} from "../contract/repositories/business-settings.contract";
import { KINDS, type Kind } from "../contract/support";
import { seedBusiness, seedUser } from "../contract/seed";
import { createPrismaClient } from "@/shared/database/database-client";

/** Plan of 02/11/2026 (M1): the settings contract against Postgres and the twin. */
const prisma = createPrismaClient();

let editorId = "";
let otherEditorId = "";

const harnesses: Record<Kind, () => BusinessSettingsHarness> = {
  prisma: () => ({
    kind: "prisma",
    repo: new BusinessSettingsRepository(prisma),
    editorId,
    otherEditorId,
  }),
  "in-memory": (() => {
    const memory = new InMemoryBusinessSettingsRepository();

    return () => ({ kind: "in-memory", repo: memory, editorId, otherEditorId });
  })(),
};

beforeAll(async () => {
  await seedBusiness(prisma, ALFA, 1);
  await seedBusiness(prisma, BETA, 2);
  await seedBusiness(prisma, GAMMA, 3);

  editorId = (await seedUser(prisma, ALFA, 1, { role: "BUSINESS_ADMIN" })).id;
  otherEditorId = (await seedUser(prisma, null, 2, { role: "MASTER" })).id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe.each(KINDS)("business settings repository (%s)", (kind) => {
  businessSettingsRepositoryContract(harnesses[kind]);
});
