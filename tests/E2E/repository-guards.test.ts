import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { DeliveryRepository } from "@/modules/delivery/repositories/delivery-repository";
import { DeliveryStatusConflictError } from "@/modules/delivery/usecases/errors/delivery-errors";
import { FuelRepository } from "@/modules/fuel/repositories/fuel-repository";
import { ActivityRepository } from "@/modules/activity/repositories/activity-repository";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * The guards that exist only in a Prisma `where`, proved against Postgres.
 *
 * Every unit test of these paths runs on an InMemory repository, which means
 * it proves the fake: remove `status: patch.expectedStatus` from the real
 * repository and the whole unit suite stays green, because the fake still
 * filters. There is no constraint behind a status precondition — a
 * transition is not something SQL can express — so this file is the only
 * thing that notices.
 *
 * Races use TWO PrismaClients, so the two writes really travel on separate
 * connections, the way two replicas (or two requests on one replica's pool)
 * would. A single client would serialise nothing, but it would also prove
 * nothing about what the database decides.
 */
const prisma = createPrismaClient();
const otherConnection = createPrismaClient();

const CARRIER = "018fe000-0000-7000-8000-0000000009a1";

// Two repositories on two connections: the dispatcher's request and the
// control tower's, arriving together.
const dispatcher = new DeliveryRepository(prisma);
const controlTower = new DeliveryRepository(otherConnection);

let shipperId = "";
let userId = "";
let branchId = "";
let vehicleId = "";
let driverId = "";
let fuelTypeId = "";

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora das Guardas",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: "10333888000101",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `guardas-${randomUUID()}@exemplo.com.br`,
      vehicle_limit: 10,
    },
  });

  shipperId = (
    await prisma.shipper.create({
      data: { name: "Embarcador", businessId: CARRIER },
    })
  ).id;

  userId = (
    await prisma.user.create({
      data: {
        name: "Gestora",
        email: `gestora-guardas-${randomUUID()}@exemplo.com.br`,
        password: "nao-usado",
        role: "BUSINESS_ADMIN",
        businessId: CARRIER,
      },
    })
  ).id;

  branchId = (
    await prisma.branch.create({
      data: {
        corporate_reason: `Filial ${randomUUID().slice(0, 8)}`,
        cep: "01001000",
        city: "São Paulo",
        uf: "SP",
        street: "Rua",
        address_number: "1",
        cnpj: "10333888000282",
        cnae: "4930202",
        responsible_name: "Responsável",
        telephone: "11999999999",
        email: `filial-guardas-${randomUUID()}@exemplo.com.br`,
        businessId: CARRIER,
      },
    })
  ).id;

  fuelTypeId = (
    await prisma.fuelType.create({
      data: { description: "Diesel", businessId: CARRIER },
    })
  ).id;

  vehicleId = (
    await prisma.vehicle.create({
      data: {
        description: "Caminhão",
        license_plate: "GRD1A23",
        brand: "Volvo",
        model: "FH",
        acquisition_date: new Date(),
        fleet_type: "OWNED",
        current_mileage: 1_000,
        maintenance_interval_km: 10_000,
        maintenance_interval_months: 6,
        renavam: `rnv-grd-${randomUUID().slice(0, 8)}`,
        manufacturing_year: new Date(),
        model_year: new Date(),
        km_per_liter: 3,
        number_of_axles: 3,
        status: "ACTIVE",
        businessId: CARRIER,
        branchId,
        fuelTypeId,
      },
    })
  ).id;

  driverId = (
    await prisma.driver.create({
      data: {
        name: "Motorista",
        birth_date: new Date("1990-01-01"),
        cnh: randomUUID().slice(0, 11),
        cpf: `cpf-${randomUUID()}`,
        rg: `rg-${randomUUID()}`,
        cep: "01001000",
        city: "São Paulo",
        uf: "SP",
        street: "Rua",
        address_number: "1",
        status: "ACTIVE",
        contract_type: "OWNED",
        businessId: CARRIER,
      },
    })
  ).id;
}, 120_000);

afterAll(async () => {
  await otherConnection.$disconnect();
  await prisma.$disconnect();
});

async function pendingDelivery(): Promise<string> {
  const delivery = await prisma.delivery.create({
    data: {
      recipient_name: "Cliente",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      businessId: CARRIER,
      shipperId,
      status: "PENDING",
    },
  });

  return delivery.id;
}

async function statusOf(deliveryId: string) {
  return (
    await prisma.delivery.findUniqueOrThrow({ where: { id: deliveryId } })
  ).status;
}

describe("a status write that read a status which is no longer there", () => {
  it("is refused, and the row keeps what the other writer decided", async () => {
    const deliveryId = await pendingDelivery();

    // The dispatcher's cancel landed between the tower's read and its write.
    await prisma.delivery.update({
      where: { id: deliveryId },
      data: { status: "CANCELLED" },
    });

    await expect(
      controlTower.updateDeliveryStatus(deliveryId, {
        status: "IN_TRANSIT",
        expectedStatus: "PENDING",
      }),
    ).rejects.toBeInstanceOf(DeliveryStatusConflictError);

    // A cancelled delivery back on the road, with nobody told, is the defect.
    expect(await statusOf(deliveryId)).toBe("CANCELLED");
  });

  it("goes through when the row still holds the status it read", async () => {
    // The control: without it, a repository that refused everything would
    // pass the case above.
    const deliveryId = await pendingDelivery();

    const moved = await controlTower.updateDeliveryStatus(deliveryId, {
      status: "IN_TRANSIT",
      expectedStatus: "PENDING",
    });

    expect(moved.status).toBe("IN_TRANSIT");
    expect(await statusOf(deliveryId)).toBe("IN_TRANSIT");
  });
});

describe("two status writes racing on separate connections", () => {
  it("lets exactly one land, and the row holds the winner's status", async () => {
    // Several rounds: one round can happen to serialise on its own, and the
    // assertion has to hold whichever connection gets there first.
    for (let round = 0; round < 5; round += 1) {
      const deliveryId = await pendingDelivery();

      const [cancelling, dispatching] = await Promise.allSettled([
        dispatcher.updateDeliveryStatus(deliveryId, {
          status: "CANCELLED",
          expectedStatus: "PENDING",
        }),
        controlTower.updateDeliveryStatus(deliveryId, {
          status: "IN_TRANSIT",
          expectedStatus: "PENDING",
        }),
      ]);

      expect(
        [cancelling.status, dispatching.status].sort(),
        `rodada ${round}: as duas escritas passaram — a pré-condição sumiu do where`,
      ).toEqual(["fulfilled", "rejected"]);

      const loser = [cancelling, dispatching].find(
        (result) => result.status === "rejected",
      ) as PromiseRejectedResult;

      expect(loser.reason).toBeInstanceOf(DeliveryStatusConflictError);

      expect(await statusOf(deliveryId)).toBe(
        cancelling.status === "fulfilled" ? "CANCELLED" : "IN_TRANSIT",
      );
    }
  });
});

describe("a proof arriving for a delivery that was cancelled meanwhile", () => {
  it("is refused whole: no DELIVERED stamp and no PROOF event", async () => {
    const deliveryId = await pendingDelivery();

    await prisma.delivery.update({
      where: { id: deliveryId },
      data: { status: "CANCELLED" },
    });

    await expect(
      dispatcher.registerDeliveryProof(
        {
          type: "PROOF",
          deliveryId,
          reportedById: userId,
          photo: "deliveryProof/x/foto.webp",
          received_by: "Porteiro",
          client_submission_id: randomUUID(),
        },
        "IN_TRANSIT",
      ),
    ).rejects.toBeInstanceOf(DeliveryStatusConflictError);

    expect(await statusOf(deliveryId)).toBe("CANCELLED");

    expect(
      await prisma.deliveryEvent.count({
        where: { deliveryId, type: "PROOF" },
      }),
    ).toBe(0);
  });

  it("lands, event and stamp together, while the delivery is still on the road", async () => {
    const deliveryId = await pendingDelivery();

    await prisma.delivery.update({
      where: { id: deliveryId },
      data: { status: "IN_TRANSIT" },
    });

    await dispatcher.registerDeliveryProof(
      {
        type: "PROOF",
        deliveryId,
        reportedById: userId,
        photo: "deliveryProof/x/foto.webp",
        received_by: "Porteiro",
        client_submission_id: randomUUID(),
      },
      "IN_TRANSIT",
    );

    expect(await statusOf(deliveryId)).toBe("DELIVERED");

    expect(
      await prisma.deliveryEvent.count({
        where: { deliveryId, type: "PROOF" },
      }),
    ).toBe(1);
  });
});

describe("a refuelling the phone sent twice", () => {
  function refuelling(clientSubmissionId: string, mileage: number) {
    return {
      client_submission_id: clientSubmissionId,
      current_mileage: mileage,
      liters_amount: 100,
      price_per_liter: 6,
      odometer_photo: "fuelOdometer/x/foto.webp",
      refueling_date: new Date(),
      businessId: CARRIER,
      branchId,
      vehicleId,
      driverId,
      fuelTypeId,
      created_from: "MOBILE_APP" as const,
    };
  }

  async function mileage(): Promise<number> {
    return (
      await prisma.vehicle.findUniqueOrThrow({ where: { id: vehicleId } })
    ).current_mileage;
  }

  it("is recorded once when the retry comes after the first answer was lost", async () => {
    const submission = randomUUID();
    const before = await mileage();

    const fuels = new FuelRepository(prisma);

    const first = await fuels.createFuelWithMileage(
      refuelling(submission, before + 300),
    );

    // Same body, again: the outbox never saw the first 201.
    const replay = await fuels.createFuelWithMileage(
      refuelling(submission, before + 300),
    );

    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay.fuel.id).toBe(first.fuel.id);

    // Without the replay lookup the second call fails the mileage rule
    // (300 km is no longer ahead of the odometer) — the phone would keep a
    // refuelling it can never send, or drop it.
    expect(await mileage()).toBe(before + 300);

    expect(
      await prisma.fuel.count({
        where: { businessId: CARRIER, client_submission_id: submission },
      }),
    ).toBe(1);
  });

  it("is recorded once when both copies arrive at the same moment", async () => {
    const submission = randomUUID();
    const before = await mileage();

    const [a, b] = await Promise.all([
      new FuelRepository(prisma).createFuelWithMileage(
        refuelling(submission, before + 250),
      ),
      new FuelRepository(otherConnection).createFuelWithMileage(
        refuelling(submission, before + 250),
      ),
    ]);

    expect(a.fuel.id).toBe(b.fuel.id);
    expect([a.created, b.created].sort()).toEqual([false, true]);

    expect(await mileage()).toBe(before + 250);

    expect(
      await prisma.fuel.count({
        where: { businessId: CARRIER, client_submission_id: submission },
      }),
    ).toBe(1);
  });
});

describe("the activity the notification pipeline records", () => {
  it("is one row however many workers record the same delivery at once", async () => {
    const deliveryId = randomUUID();

    const record = (repository: ActivityRepository) =>
      repository.createActivity({
        type: "Entrega",
        action: "update",
        entityId: randomUUID(),
        description: "Entrega saiu para rota",
        status: "Atualizado",
        performedBy: userId,
        businessId: CARRIER,
        deliveryId,
      });

    // Five at once, over two connections. Prisma runs an upsert with an
    // empty `update` as a SELECT and then an INSERT, so several callers pass
    // the SELECT and the losers get P2002. The repository reads the winner's
    // row back on that P2002: every caller gets the same row and none throws.
    const results = await Promise.allSettled([
      record(new ActivityRepository(prisma)),
      record(new ActivityRepository(otherConnection)),
      record(new ActivityRepository(prisma)),
      record(new ActivityRepository(otherConnection)),
      record(new ActivityRepository(prisma)),
    ]);

    const failures = results
      .filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      )
      .map((result) =>
        result.reason instanceof Prisma.PrismaClientKnownRequestError
          ? result.reason.code
          : String(result.reason),
      );

    expect(failures, "uma gravação concorrente falhou").toEqual([]);

    const ids = new Set(
      results.map(
        (result) => (result as PromiseFulfilledResult<{ id: string }>).value.id,
      ),
    );

    expect(ids.size).toBe(1);
    expect(await prisma.activity.count({ where: { deliveryId } })).toBe(1);
  });
});
