import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import {
  seedFleetDriver,
  type FleetDriverSeed,
} from "./support/fleet-driver-seed";
import { seedJourneyRoute } from "./support/journey-route-seed";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * Taking a driver off the road while a route still needs them (K10, decision
 * D31), through the real routes and a real database.
 *
 * Deactivating the driver was already refused (decision 8.3). Revoking the
 * login and deactivating the driver's branch lock the app out in exactly the
 * same way — session-eligibility refuses both — and were not: the route never
 * closed, and the phone's outbox stalled on "auth" with the day's proofs in
 * it. Both are now refused with the same 409 DRIVER_HAS_OPEN_ROUTES and the
 * same counts and steps; undoing them (restoring, reactivating) never is.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];
let carrier: FleetDriverSeed;

const CARRIER = "018fe1f0-0000-7000-8000-00000000000a";

const refusal = (response: {
  statusCode: number;
  json: () => { code?: string };
}) => `${response.statusCode} ${response.json().code}`;

const revoke = (userId: string) =>
  app.inject({
    method: "PATCH",
    url: `/user/revoke-access/${userId}`,
    headers: { authorization: `Bearer ${carrier.managerToken}` },
  });

const toggleBranch = (branchId: string) =>
  app.inject({
    method: "PATCH",
    url: `/branch/toggle-branch-active/${branchId}/business/${CARRIER}`,
    headers: { authorization: `Bearer ${carrier.managerToken}` },
  });

async function closeRoutesOf(driverId: string): Promise<void> {
  await prisma.route.updateMany({
    where: { driverId, status: { in: ["PLANNED", "RELEASED", "IN_PROGRESS"] } },
    data: { status: "CANCELLED", cancellation_reason: "Teste" },
  });
}

async function driverInBranch(branchId: string | null): Promise<string> {
  const driver = await prisma.driver.create({
    data: {
      name: "Outro motorista",
      birth_date: new Date("1990-01-01"),
      cnh: randomUUID().replace(/-/g, "").slice(0, 11),
      cpf: randomUUID().slice(0, 14),
      rg: randomUUID().slice(0, 12),
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId: CARRIER,
      branchId,
    },
  });

  return driver.id;
}

beforeAll(async () => {
  carrier = await seedFleetDriver(prisma, {
    businessId: CARRIER,
    cnpj: "55667001000191",
  });

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
}, 60_000);

describe("revoking a driver's login", () => {
  it("is refused while the driver has a route in progress, and nothing changes", async () => {
    await seedJourneyRoute(prisma, CARRIER, carrier.driverId, {
      status: "IN_PROGRESS",
    });

    const response = await revoke(carrier.driverUserId);

    expect(refusal(response), response.body).toBe("409 DRIVER_HAS_OPEN_ROUTES");
    expect(response.json().message).toContain(
      "Não é possível revogar o acesso deste usuário",
    );
    expect(response.json().message).toContain("1 rota em andamento");

    const user = await prisma.user.findUniqueOrThrow({
      where: { id: carrier.driverUserId },
    });

    expect(user.access_revoked).toBe(false);

    await closeRoutesOf(carrier.driverId);
  });

  it("goes through once nothing is open, and restoring is never refused", async () => {
    const revoked = await revoke(carrier.driverUserId);
    expect(revoked.statusCode, revoked.body).toBe(200);

    // A route released meanwhile does not hold the restore back: giving the
    // login back is what lets that route run.
    await seedJourneyRoute(prisma, CARRIER, carrier.driverId, {
      status: "RELEASED",
    });

    const restored = await revoke(carrier.driverUserId);
    expect(restored.statusCode, restored.body).toBe(200);

    await closeRoutesOf(carrier.driverId);
  });
});

describe("deactivating a branch", () => {
  it("is refused while one of its drivers has an open route, and nothing changes", async () => {
    await seedJourneyRoute(prisma, CARRIER, carrier.driverId, {
      status: "RELEASED",
    });

    const response = await toggleBranch(carrier.branchId);

    expect(refusal(response), response.body).toBe("409 DRIVER_HAS_OPEN_ROUTES");
    expect(response.json().message).toContain(
      "Não é possível desativar esta filial",
    );

    const branch = await prisma.branch.findUniqueOrThrow({
      where: { id: carrier.branchId },
    });

    expect(branch.is_active).toBe(true);

    await closeRoutesOf(carrier.driverId);
  });

  it("ignores the routes of drivers of other branches", async () => {
    const elsewhere = await driverInBranch(null);

    await seedJourneyRoute(prisma, CARRIER, elsewhere, {
      status: "IN_PROGRESS",
    });

    const off = await toggleBranch(carrier.branchId);
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json().is_active).toBe(false);

    // Reactivating is never refused, open routes or not.
    await seedJourneyRoute(prisma, CARRIER, carrier.driverId, {
      status: "RELEASED",
    });

    const on = await toggleBranch(carrier.branchId);
    expect(on.statusCode, on.body).toBe(200);

    await closeRoutesOf(carrier.driverId);
    await closeRoutesOf(elsewhere);
  });
});
