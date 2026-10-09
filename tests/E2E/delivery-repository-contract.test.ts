import { afterAll, beforeAll, describe } from "vitest";

import { PrismaClient, type Prisma } from "@prisma/client";

import { DeliveryRepository } from "@/modules/delivery/repositories/delivery-repository";
import { InMemoryDeliveryRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-repository";

import {
  DELIVERY_FIXTURE as F,
  deliveryRepositoryContract,
  seedThrough,
  type DeliveryHarness,
} from "../contract/repositories/delivery.contract";
import { KINDS, type Kind } from "../contract/support";
import {
  seedBusiness,
  seedDriver,
  seedShipper,
  seedUser,
  seedVehicle,
} from "../contract/seed";

/** Decision 13.2: the delivery contract against Postgres and the twin. */
const prisma = new PrismaClient();

const prismaRepo = new DeliveryRepository(prisma);
const memory = new InMemoryDeliveryRepository();

const seeded: Record<
  Kind,
  Awaited<ReturnType<typeof seedThrough>>
> = {} as never;

const harnessOf = (kind: Kind): DeliveryHarness => ({
  kind,
  repo: kind === "prisma" ? prismaRepo : memory,
  id: (key: string) => {
    const id = seeded[kind].deliveries.get(key);
    if (!id) throw new Error(`no delivery ${key}`);
    return id;
  },
  occurrence: (key: string) => {
    const id = seeded[kind].occurrences.get(key);
    if (!id) throw new Error(`no occurrence ${key}`);
    return id;
  },
});

const harnesses: Record<Kind, DeliveryHarness> = {
  prisma: harnessOf("prisma"),
  "in-memory": harnessOf("in-memory"),
};

async function seedPostgres(): Promise<void> {
  await seedBusiness(prisma, F.A, 1);
  await seedBusiness(prisma, F.B, 2);

  await seedShipper(prisma, F.A, "Alfa Embarcador", F.shipperA);
  await seedShipper(prisma, F.A, "Alfa Filial", F.shipperA2);
  await seedShipper(prisma, F.B, "Bravo Embarcador", F.shipperB);

  await seedDriver(prisma, F.A, 1, {
    id: F.driverA,
    name: F.driverName,
    cnh: F.driverCnh,
  });
  await seedVehicle(prisma, F.A, F.plate, { id: F.vehicleA });

  await seedUser(prisma, F.A, 1, { id: F.userA, name: F.userName });
  await seedUser(prisma, F.A, 2, { id: F.deciderA, name: F.deciderName });

  await prisma.occurrenceType.create({
    data: {
      id: F.typeA,
      name: F.typeName,
      blocks_delivery: true,
      form_fields: F.formFields as unknown as Prisma.InputJsonValue,
      businessId: F.A,
    },
  });
  await prisma.statusChangeReason.create({
    data: { id: F.reasonA, name: F.reasonName, businessId: F.A },
  });
  await prisma.route.create({
    data: {
      id: F.routeA,
      code: F.routeCode,
      scheduled_date: new Date("2026-09-01T00:00:00.000Z"),
      businessId: F.A,
      driverId: F.driverA,
    },
  });
}

function seedTwin(): void {
  memory.shipperNames.set(F.shipperA, "Alfa Embarcador");
  memory.shipperNames.set(F.shipperA2, "Alfa Filial");
  memory.shipperNames.set(F.shipperB, "Bravo Embarcador");
  memory.driverDirectory.set(F.driverA, {
    name: F.driverName,
    cnh: F.driverCnh,
  });
  memory.vehiclePlates.set(F.vehicleA, F.plate);
  memory.reporterNames.set(F.userA, F.userName);
  memory.reporterNames.set(F.deciderA, F.deciderName);
  memory.seedOccurrenceType({
    id: F.typeA,
    businessId: F.A,
    name: F.typeName,
    blocks_delivery: true,
  });
  memory.occurrenceTypeFormFields.set(F.typeA, F.formFields);
  memory.reasonNames.set(F.reasonA, F.reasonName);
  memory.routeCodes.set(F.routeA, F.routeCode);
}

beforeAll(async () => {
  await seedPostgres();
  seedTwin();

  seeded.prisma = await seedThrough(prismaRepo, {
    delivery: async (id, at) => {
      await prisma.delivery.update({ where: { id }, data: { created_at: at } });
    },
    occurrence: async (id, at) => {
      await prisma.deliveryOccurrence.update({
        where: { id },
        data: { created_at: at },
      });
    },
    event: async (at) => {
      await prisma.deliveryEvent.updateMany({ data: { created_at: at } });
    },
  });

  seeded["in-memory"] = await seedThrough(memory, {
    delivery: async (id, at) => {
      memory.deliveries.find((row) => row.id === id)!.created_at = at;
    },
    occurrence: async (id, at) => {
      memory.occurrences.find((row) => row.id === id)!.created_at = at;
    },
    event: async (at) => {
      for (const event of memory.events) event.created_at = at;
    },
  });

  // d1 sits on route 7 (its latest stop), in both.
  await prisma.routeStop.create({
    data: {
      routeId: F.routeA,
      deliveryId: seeded.prisma.deliveries.get("d1")!,
      sequence: 1,
    },
  });
  memory.routeStops.push({
    routeId: F.routeA,
    deliveryId: seeded["in-memory"].deliveries.get("d1")!,
    status: "PENDING",
    created_at: new Date(),
  });
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe.each(KINDS)("delivery repository (%s)", (kind) => {
  deliveryRepositoryContract(() => harnesses[kind]);
});
