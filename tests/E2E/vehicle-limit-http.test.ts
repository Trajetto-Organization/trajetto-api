import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import { sign } from "jsonwebtoken";

import auth from "@/config/auth";
import { VehicleRepository } from "@/modules/vehicle/repositories/vehicle-repository";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * The contracted fleet, end to end (plan M8, S18).
 *
 * The limit is a billing control, so it has to hold where it is easy to
 * slip: the N+1th registration, a vehicle brought back from INACTIVE, two
 * registrations racing for the last slot — on one replica or on two — and an
 * edit that runs while somebody else frees and takes a slot. And 0 has to
 * stay "no limit" (M2), or every company that never filled the field would
 * be locked out of its own fleet.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const RUN = randomUUID().slice(0, 8);

let plateSeq = 0;
let cnpjSeq = 0;

interface Company {
  id: string;
  fuelTypeId: string;
  token: string;
}

async function company(vehicleLimit: number): Promise<Company> {
  const id = randomUUID();

  cnpjSeq += 1;

  await prisma.business.create({
    data: {
      id,
      corporate_reason: `Transportadora Frota ${RUN} ${cnpjSeq}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(
        43222555000100 + Math.floor(Math.random() * 90_000) * 10 + cnpjSeq,
      ),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `frota-${RUN}-${cnpjSeq}@exemplo.com.br`,
      vehicle_limit: vehicleLimit,
    },
  });

  await prisma.businessEntitlement.createMany({
    data: [
      { businessId: id, module: "FLEET", enabled: true },
      { businessId: id, module: "DELIVERIES", enabled: true },
    ],
  });

  const fuelTypeId = (
    await prisma.fuelType.create({
      data: { description: "Diesel", businessId: id },
    })
  ).id;

  const adminId = randomUUID();
  const familyId = randomUUID();

  await prisma.user.create({
    data: {
      id: adminId,
      name: "Gestora da Frota",
      email: `${adminId}@exemplo.com.br`,
      password: "nao-usado",
      role: "BUSINESS_ADMIN",
      businessId: id,
    },
  });

  await prisma.refreshToken.create({
    data: {
      userId: adminId,
      token_hash: randomUUID(),
      jti: randomUUID(),
      family_id: familyId,
      expires_in: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

  const token = sign(
    { tokenType: "access", sessionVersion: 0, familyId },
    auth.secret_token,
    { subject: adminId, expiresIn: "1h" },
  );

  return { id, fuelTypeId, token };
}

function nextPlate(): { license_plate: string; renavam: string } {
  plateSeq += 1;

  const suffix = String(plateSeq).padStart(3, "0");

  return {
    license_plate: `LMT${plateSeq % 10}A${suffix.slice(-2)}`,
    renavam: `7${RUN.replace(/\D/g, "1").slice(0, 4)}${suffix}`.padEnd(11, "0"),
  };
}

/** A vehicle row straight in the table: the fleet the test starts from. */
async function vehicleIn(
  target: Company,
  status: "ACTIVE" | "INACTIVE" | "BLOCKED" = "ACTIVE",
) {
  return prisma.vehicle.create({
    data: {
      description: "Caminhão",
      brand: "Volvo",
      model: "FH",
      acquisition_date: new Date("2024-01-10"),
      fleet_type: "OWNED",
      current_mileage: 1000,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      manufacturing_year: new Date("2024-01-01"),
      model_year: new Date("2025-01-01"),
      km_per_liter: 2.5,
      number_of_axles: 2,
      status,
      businessId: target.id,
      fuelTypeId: target.fuelTypeId,
      ...nextPlate(),
    },
  });
}

function register(target: Company, overrides: Record<string, unknown> = {}) {
  return app.inject({
    method: "POST",
    url: `/vehicle/create-vehicle/${target.id}`,
    headers: { authorization: `Bearer ${target.token}` },
    payload: {
      description: "Caminhão novo",
      brand: "Scania",
      model: "R450",
      acquisition_date: "2024-05-01",
      fleet_type: "THIRD_PARTY",
      current_mileage: 500,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      manufacturing_year: "2025-01-01",
      model_year: "2026-01-01",
      km_per_liter: 3.25,
      number_of_axles: 2,
      status: "ACTIVE",
      fuelTypeId: target.fuelTypeId,
      ...nextPlate(),
      ...overrides,
    },
  });
}

function edit(
  target: Company,
  vehicleId: string,
  body: Record<string, unknown>,
) {
  return app.inject({
    method: "PATCH",
    url: `/vehicle/update-vehicle/${vehicleId}/business/${target.id}`,
    headers: { authorization: `Bearer ${target.token}` },
    payload: body,
  });
}

function slotsInUse(target: Company) {
  return prisma.vehicle.count({
    where: { businessId: target.id, status: { not: "INACTIVE" } },
  });
}

beforeAll(async () => {
  ({ app } = await import("@/http"));
  await app.ready();
}, 180_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

describe("the contracted fleet over HTTP (M8)", () => {
  it("refuses the N+1th registration with a message that says the count and the way out", async () => {
    const full = await company(2);

    await vehicleIn(full);
    await vehicleIn(full);

    const refused = await register(full);

    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().code).toBe("VEHICLE_LIMIT_REACHED");
    expect(refused.json().message).toBe(
      "Limite de veículos contratados atingido (2/2 ativos). " +
        "Inative um veículo ou fale com o suporte para ampliar o plano da empresa.",
    );

    expect(await slotsInUse(full)).toBe(2);
  });

  it("registers an inactive vehicle at the limit, since it takes no slot", async () => {
    const full = await company(1);

    await vehicleIn(full);

    const inactive = await register(full, { status: "INACTIVE" });

    expect(inactive.statusCode, inactive.body).toBe(201);
    expect(await slotsInUse(full)).toBe(1);
  });

  it("counts a vehicle brought back from INACTIVE against the limit", async () => {
    const full = await company(2);

    const parked = await vehicleIn(full, "INACTIVE");
    const running = await vehicleIn(full);
    await vehicleIn(full, "BLOCKED");

    const refused = await edit(full, parked.id, { status: "ACTIVE" });

    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().code).toBe("VEHICLE_LIMIT_REACHED");
    expect(refused.json().message).toContain("Para reativar este veículo");

    // Freeing a slot is the customer's lever: then the comeback fits.
    expect(
      (await edit(full, running.id, { status: "INACTIVE" })).statusCode,
    ).toBe(200);
    expect((await edit(full, parked.id, { status: "ACTIVE" })).statusCode).toBe(
      200,
    );

    expect(await slotsInUse(full)).toBe(2);
  });

  it("unblocks a truck of a fleet above a lowered limit, since it already holds its slot", async () => {
    const lowered = await company(1);

    const blocked = await vehicleIn(lowered, "BLOCKED");
    await vehicleIn(lowered);

    // Two slots on a plan of one: the limit was lowered below the fleet.
    const unblocked = await edit(lowered, blocked.id, { status: "ACTIVE" });

    expect(unblocked.statusCode, unblocked.body).toBe(200);
    expect(await slotsInUse(lowered)).toBe(2);
  });

  it("never blocks while the limit is 0", async () => {
    const unlimited = await company(0);

    for (let vehicle = 0; vehicle < 3; vehicle += 1) {
      const created = await register(unlimited);

      expect(created.statusCode, created.body).toBe(201);
    }

    const parked = await vehicleIn(unlimited, "INACTIVE");

    expect(
      (await edit(unlimited, parked.id, { status: "ACTIVE" })).statusCode,
    ).toBe(200);
    expect(await slotsInUse(unlimited)).toBe(4);
  });

  it("lets only one of several simultaneous registrations take the last slot", async () => {
    const almost = await company(3);

    await vehicleIn(almost);
    await vehicleIn(almost);

    const answers = await Promise.all(
      Array.from({ length: 5 }, () => register(almost)),
    );

    // The whole list, sorted: one 201 and four 409s, nothing else.
    expect(answers.map((answer) => answer.statusCode).sort()).toEqual([
      201, 409, 409, 409, 409,
    ]);
    expect(await slotsInUse(almost)).toBe(3);
  });
});

describe("the contracted fleet across replicas (M8)", () => {
  /**
   * Two replicas share nothing but Postgres: each its own pool, its own
   * process. Two clients on separate pools stand for them here — the lock on
   * the company's row is in the database, so it holds for both or for none.
   */
  it("gives the last slot to one replica only, whether it registers or reactivates", async () => {
    const almost = await company(2);

    await vehicleIn(almost);
    const parked = await vehicleIn(almost, "INACTIVE");

    const replicaA = createPrismaClient();
    const replicaB = createPrismaClient();

    const row = (businessId: string, fuelTypeId: string) => ({
      description: "Caminhão",
      brand: "Volvo",
      model: "FH",
      acquisition_date: new Date("2024-01-10"),
      fleet_type: "OWNED" as const,
      current_mileage: 0,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      manufacturing_year: new Date("2024-01-01"),
      model_year: new Date("2025-01-01"),
      km_per_liter: 3,
      number_of_axles: 2,
      status: "ACTIVE" as const,
      businessId,
      fuelTypeId,
      ...nextPlate(),
    });

    try {
      const outcomes = await Promise.all([
        new VehicleRepository(replicaA).createVehicleWithinLimit(
          row(almost.id, almost.fuelTypeId) as never,
          { max: 2, occupiesSlot: true },
        ),
        new VehicleRepository(replicaB).createVehicleWithinLimit(
          row(almost.id, almost.fuelTypeId) as never,
          { max: 2, occupiesSlot: true },
        ),
        new VehicleRepository(replicaB).updateVehicleWithinLimit(
          {
            vehicleId: parked.id,
            businessId: almost.id,
            vehicleData: { status: "ACTIVE" },
          } as never,
          { max: 2 },
        ),
      ]);

      expect(
        outcomes.filter((outcome) => outcome.vehicle !== null),
      ).toHaveLength(1);
      expect(await slotsInUse(almost)).toBe(2);
    } finally {
      await replicaA.$disconnect();
      await replicaB.$disconnect();
    }
  });
});

describe("an edit racing a slot that is freed and taken (M8)", () => {
  /**
   * Unblocking a truck (BLOCKED → ACTIVE) is not a reactivation: both take
   * a slot. The edit decided that from the truck it read before writing. In
   * between, somebody inactivated the truck and a new one took the freed
   * slot; the edit then wrote ACTIVE over INACTIVE without counting, and the
   * company ended with N+1 vehicles on a plan of N. The decision is now made
   * under the company's lock, from the truck as it is there.
   *
   * Forced, not hoped for: the truck's row is held locked while the edit
   * reads it and reaches its write; in that window the truck is inactivated
   * and the freed slot is taken, as the two other requests would leave them.
   */
  it("counts the vehicle it brings back, even when it read it in a slot", async () => {
    const full = await company(2);

    const contested = await vehicleIn(full, "BLOCKED");
    await vehicleIn(full);

    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => (release = resolve));

    let held: () => void = () => undefined;
    const holding = new Promise<void>((resolve) => (held = resolve));

    const otherRequests = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`
          SELECT "id" FROM "vehicle" WHERE "id" = ${contested.id} FOR UPDATE
        `;

        held();
        await released;

        // Somebody inactivates the truck, and a new one takes its slot.
        await tx.vehicle.update({
          where: { id: contested.id },
          data: { status: "INACTIVE" },
        });

        await tx.vehicle.create({
          data: {
            description: "Caminhão que ocupou a vaga",
            brand: "Volvo",
            model: "FH",
            acquisition_date: new Date("2024-01-10"),
            fleet_type: "OWNED",
            current_mileage: 0,
            maintenance_interval_km: 10000,
            maintenance_interval_months: 6,
            manufacturing_year: new Date("2024-01-01"),
            model_year: new Date("2025-01-01"),
            km_per_liter: 3,
            number_of_axles: 2,
            status: "ACTIVE",
            businessId: full.id,
            fuelTypeId: full.fuelTypeId,
            ...nextPlate(),
          },
        });
      },
      { maxWait: 10_000, timeout: 30_000 },
    );

    await holding;

    // The manager unblocks the truck.
    const editing = edit(full, contested.id, { status: "ACTIVE" });

    // Let the edit read the truck as BLOCKED and queue its write behind the
    // lock, then let the other two requests commit.
    await waitForLockWaiter(contested.id);
    release();
    await otherRequests;

    const answer = await editing;

    // Red before: 200, and three trucks on a plan of two.
    expect(await slotsInUse(full)).toBe(2);
    expect(answer.statusCode, answer.body).toBe(409);
    expect(answer.json().code).toBe("VEHICLE_LIMIT_REACHED");
  });
});

/**
 * Waits until a session is blocked on a lock in the vehicle table — the
 * edit's write queued behind the held row (or behind the company's lock,
 * once the decision is taken there). State, never time.
 */
async function waitForLockWaiter(vehicleId: string): Promise<void> {
  const deadline = Date.now() + 15_000;

  while (Date.now() < deadline) {
    const [{ waiting }] = await prisma.$queryRaw<Array<{ waiting: number }>>`
      SELECT count(*)::int AS "waiting"
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND pid <> pg_backend_pid()
    `;

    if (waiting > 0) return;

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(
    `a edição do veículo ${vehicleId} não chegou a esperar o lock`,
  );
}
