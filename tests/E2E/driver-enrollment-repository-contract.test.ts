import { afterAll, beforeAll, describe } from "vitest";

import { DriverEnrollmentRepository } from "@/modules/user/repositories/driver-enrollment-repository";
import { InMemoryDriverEnrollmentRepository } from "@/modules/user/repositories/in-memory/in-memory-driver-enrollment-repository";

import {
  COMPANY,
  driverEnrollmentRepositoryContract,
  type DriverEnrollmentHarness,
} from "../contract/repositories/driver-enrollment.contract";
import { KINDS, type Kind } from "../contract/support";
import { seedBusiness, seedDriver, seedUser } from "../contract/seed";
import { createPrismaClient } from "@/shared/database/database-client";

/** Plan of 02/11/2026 (D3): the QR access contract against Postgres and the twin. */
const prisma = createPrismaClient();

const DRIVERS = 10;

const driverUserIds: string[] = [];
let managerId = "";

const memory = new InMemoryDriverEnrollmentRepository();

const harnesses: Record<Kind, () => DriverEnrollmentHarness> = {
  prisma: () => ({
    kind: "prisma",
    repo: new DriverEnrollmentRepository(prisma),
    driverUserIds,
    managerId,
  }),
  "in-memory": () => ({
    kind: "in-memory",
    repo: memory,
    driverUserIds,
    managerId,
  }),
};

beforeAll(async () => {
  await seedBusiness(prisma, COMPANY, 1);

  managerId = (await seedUser(prisma, COMPANY, 100, { role: "BUSINESS_ADMIN" }))
    .id;

  for (let n = 1; n <= DRIVERS; n += 1) {
    const driver = await seedDriver(prisma, COMPANY, n);
    const user = await seedUser(prisma, COMPANY, n, { driverId: driver.id });

    driverUserIds.push(user.id);
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe.each(KINDS)("driver enrollment repository (%s)", (kind) => {
  driverEnrollmentRepositoryContract(harnesses[kind]);
});
