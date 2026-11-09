import { afterAll, beforeAll, describe } from "vitest";

import { DriverTrustedDeviceRepository } from "@/modules/user/repositories/driver-trusted-device-repository";
import { InMemoryDriverTrustedDeviceRepository } from "@/modules/user/repositories/in-memory/in-memory-driver-trusted-device-repository";

import {
  COMPANY,
  driverTrustedDeviceRepositoryContract,
  type DriverTrustedDeviceHarness,
} from "../contract/repositories/driver-trusted-device.contract";
import { KINDS, type Kind } from "../contract/support";
import { seedBusiness, seedDriver, seedUser } from "../contract/seed";
import { createPrismaClient } from "@/shared/database/database-client";

/** Wave 2 (06/11/2026): the trusted phones contract against Postgres and the twin. */
const prisma = createPrismaClient();

const DRIVERS = 11;

const driverUserIds: string[] = [];

const memory = new InMemoryDriverTrustedDeviceRepository();

const harnesses: Record<Kind, () => DriverTrustedDeviceHarness> = {
  prisma: () => ({
    kind: "prisma",
    repo: new DriverTrustedDeviceRepository(prisma),
    driverUserIds,
  }),
  "in-memory": () => ({
    kind: "in-memory",
    repo: memory,
    driverUserIds,
  }),
};

beforeAll(async () => {
  await seedBusiness(prisma, COMPANY, 1);

  for (let n = 1; n <= DRIVERS; n += 1) {
    const driver = await seedDriver(prisma, COMPANY, n);
    const user = await seedUser(prisma, COMPANY, n, { driverId: driver.id });

    driverUserIds.push(user.id);
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe.each(KINDS)("driver trusted device repository (%s)", (kind) => {
  driverTrustedDeviceRepositoryContract(harnesses[kind]);
});
