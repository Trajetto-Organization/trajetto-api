import { afterAll, beforeAll, describe } from "vitest";

import { RouteRepository } from "@/modules/route/repositories/route-repository";
import { InMemoryRouteRepository } from "@/modules/route/repositories/in-memory/in-memory-route-repository";

import {
  ROUTE_FIXTURE as F,
  routeRepositoryContract,
  seedRoutes,
  type RouteHarness,
} from "../contract/repositories/route.contract";
import { KINDS, type Kind } from "../contract/support";
import {
  seedBusiness,
  seedDriver,
  seedShipper,
  seedVehicle,
} from "../contract/seed";
import { createPrismaClient } from "@/shared/database/database-client";

/** Decision 13.2: the route contract against Postgres and the twin. */
const prisma = createPrismaClient();

const SHIPPER_A = "0e5a0000-0000-7000-8000-000000000001";
const SHIPPER_B = "0e5b0000-0000-7000-8000-000000000001";

const deliveryRows = Object.entries(F.deliveries).map(([key, id]) => ({
  id,
  businessId: key.startsWith("b") ? F.B : F.A,
  shipperId: key.startsWith("b") ? SHIPPER_B : SHIPPER_A,
  status: key === "done1" ? ("DELIVERED" as const) : ("PENDING" as const),
  recipient_name: `Cliente ${key}`,
  city: "São Paulo",
  uf: "SP",
  street: "Rua das Entregas",
}));

const prismaRepo = new RouteRepository(prisma);
const memory = new InMemoryRouteRepository(
  deliveryRows.map((row) => ({ ...row })),
  [
    {
      id: F.vehicleA,
      businessId: F.A,
      license_plate: F.plate,
      status: "ACTIVE",
    },
  ],
  [
    { id: F.driverA1, businessId: F.A, name: F.driverA1Name, status: "ACTIVE" },
    { id: F.driverA2, businessId: F.A, name: F.driverA2Name, status: "ACTIVE" },
    { id: F.driverB, businessId: F.B, name: F.driverBName, status: "ACTIVE" },
  ],
);

const routes: Partial<Record<Kind, Map<string, string>>> = {};

const harnessOf = (kind: Kind): RouteHarness => ({
  kind,
  repo: kind === "prisma" ? prismaRepo : memory,
  route: (key: string) => {
    const id = routes[kind]?.get(key);
    if (!id) throw new Error(`no route ${key}`);
    return id;
  },
});

const harnesses: Record<Kind, RouteHarness> = {
  prisma: harnessOf("prisma"),
  "in-memory": harnessOf("in-memory"),
};

beforeAll(async () => {
  await seedBusiness(prisma, F.A, 1);
  await seedBusiness(prisma, F.B, 2);
  await seedShipper(prisma, F.A, "Embarcador A", SHIPPER_A);
  await seedShipper(prisma, F.B, "Embarcador B", SHIPPER_B);
  await seedDriver(prisma, F.A, 1, { id: F.driverA1, name: F.driverA1Name });
  await seedDriver(prisma, F.A, 2, { id: F.driverA2, name: F.driverA2Name });
  await seedDriver(prisma, F.B, 3, { id: F.driverB, name: F.driverBName });
  await seedVehicle(prisma, F.A, F.plate, { id: F.vehicleA });

  for (const row of deliveryRows) await prisma.delivery.create({ data: row });

  routes.prisma = await seedRoutes(prismaRepo, async (id, at) => {
    await prisma.route.update({ where: { id }, data: { created_at: at } });
  });
  routes["in-memory"] = await seedRoutes(memory, async (id, at) => {
    memory.routes.find((route) => route.id === id)!.created_at = at;
  });
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe.each(KINDS)("route repository (%s)", (kind) => {
  routeRepositoryContract(() => harnesses[kind]);
});
