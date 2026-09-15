import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { DeliveryRepository } from "@/modules/delivery/repositories/delivery-repository";
import { VehicleRepository } from "@/modules/vehicle/repositories/vehicle-repository";
import { AccountPayableRepository } from "@/modules/account-payable/repositories/account-payable-repository";
import { UserRepository } from "@/modules/user/repositories/user-repository";

/**
 * Two requests at the same moment, and only one may win.
 *
 * Every race test that runs against a fake proves the fake. These run against
 * Postgres and fire the REAL writes in parallel — the only way to know whether
 * the precondition is in the `where` or only in the comment.
 *
 * The three cases came out of an adversarial audit, and all three are
 * read-then-write in a place where the product uses a precondition on every
 * neighbour.
 */
const prisma = new PrismaClient();

const CARRIER = "018fe000-0000-7000-8000-00000000000a";

const deliveries = new DeliveryRepository();
const vehicles = new VehicleRepository();
const payables = new AccountPayableRepository();

let branchId = "";
let fuelTypeId = "";
let shipperId = "";
let userId = "";

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora das Corridas",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: "10222888000101",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `corrida-${randomUUID()}@exemplo.com.br`,

      // Dez vagas contratadas.
      vehicle_limit: 10,
    },
  });

  const branch = await prisma.branch.create({
    data: {
      corporate_reason: `Filial ${randomUUID().slice(0, 8)}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: `12${Math.floor(Math.random() * 1e12)}`.slice(0, 14),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `filial-corrida-${randomUUID()}@exemplo.com.br`,
      businessId: CARRIER,
    },
  });

  branchId = branch.id;

  const fuelType = await prisma.fuelType.create({
    data: { description: "Diesel", businessId: CARRIER },
  });

  fuelTypeId = fuelType.id;

  const shipper = await prisma.shipper.create({
    data: { name: "Embarcador", businessId: CARRIER },
  });

  shipperId = shipper.id;

  const user = await prisma.user.create({
    data: {
      name: "Gestora",
      email: `gestora-corrida-${randomUUID()}@exemplo.com.br`,
      password: "nao-usado",
      role: "BUSINESS_ADMIN",
      businessId: CARRIER,
    },
  });

  userId = user.id;
}, 120_000);

afterAll(async () => {
  await prisma.accountPayable.deleteMany({ where: { businessId: CARRIER } });
  await prisma.delivery.deleteMany({ where: { businessId: CARRIER } });

  await prisma.vehicle.deleteMany({ where: { businessId: CARRIER } });
  await prisma.fuelType.deleteMany({ where: { businessId: CARRIER } });

  await prisma.shipper.deleteMany({ where: { businessId: CARRIER } });
  await prisma.user.deleteMany({ where: { businessId: CARRIER } });

  await prisma.branch.deleteMany({ where: { businessId: CARRIER } });
  await prisma.business.deleteMany({ where: { id: CARRIER } });

  await prisma.$disconnect();
});

function vehicleData(suffix: string) {
  return {
    description: "Caminhão",
    license_plate: `RC${suffix}`.slice(0, 10),
    brand: "Volvo",
    model: "FH",
    acquisition_date: new Date(),
    fleet_type: "OWNED" as const,
    current_mileage: 0,
    maintenance_interval_km: 10000,
    maintenance_interval_months: 6,
    renavam: `rnv-rc-${suffix}`,
    manufacturing_year: new Date(),
    model_year: new Date(),
    km_per_liter: 3,
    number_of_axles: 3,
    status: "ACTIVE" as const,
    businessId: CARRIER,
    fuelTypeId,
  };
}

describe("editing the delivery while the driver is proving it", () => {
  it("the edit is refused and nothing is rewritten", async () => {
    const delivery = await prisma.delivery.create({
      data: {
        recipient_name: "Cliente Original",
        city: "São Paulo",
        uf: "SP",
        street: "Rua",
        businessId: CARRIER,
        shipperId,
        status: "PENDING",
      },
    });

    // A comprovação landou na janela entre a leitura da use case e a escrita.
    await prisma.delivery.update({
      where: { id: delivery.id },
      data: { status: "DELIVERED", delivered_at: new Date() },
    });

    // A edição, que leu PENDING lá atrás, chega agora.
    await expect(
      deliveries.updateDelivery(
        delivery.id,
        { recipient_name: "Reescrito" },
        "PENDING",
      ),
    ).rejects.toThrow();

    const after = await prisma.delivery.findUniqueOrThrow({
      where: { id: delivery.id },
    });

    // The slip was already signed and the webhook had already gone out to the
    // customer's ERP. Rewriting the recipient and the address on top of that
    // is the defect.
    expect(after.recipient_name).toBe("Cliente Original");
    expect(after.status).toBe("DELIVERED");
  });

  it("the edit goes through when the status really is the expected one", async () => {
    // The other half of the pair: without it the test above would pass for a
    // repository that refuses everything.
    const delivery = await prisma.delivery.create({
      data: {
        recipient_name: "Cliente Editável",
        city: "São Paulo",
        uf: "SP",
        street: "Rua",
        businessId: CARRIER,
        shipperId,
        status: "PENDING",
      },
    });

    await deliveries.updateDelivery(
      delivery.id,
      { recipient_name: "Editado" },
      "PENDING",
    );

    expect(
      (await prisma.delivery.findUniqueOrThrow({ where: { id: delivery.id } }))
        .recipient_name,
    ).toBe("Editado");
  });
});

describe("the contracted fleet under concurrency", () => {
  it("does not pass the limit with ten registrations at once", async () => {
    await prisma.vehicle.deleteMany({ where: { businessId: CARRIER } });

    // Nove ocupadas de dez.
    for (let n = 0; n < 9; n += 1) {
      await prisma.vehicle.create({ data: vehicleData(`base${n}`) });
    }

    /**
     * SEPARATE connections, one per attempt.
     *
     * With a single Prisma client the ten calls queue on one pool and the
     * interleaving ends up serialising by accident — the test passed even with
     * the transaction removed entirely, proving nothing. One client per
     * attempt is ten real connections competing, which is what happens with
     * ten replicas serving ten requests.
     */
    const clients = Array.from({ length: 10 }, () => new PrismaClient());

    const attempts = await Promise.all(
      clients.map((client, n) =>
        new VehicleRepository(client)
          .createVehicleWithinLimit(vehicleData(`race${n}`), {
            max: 10,
            occupiesSlot: true,
          })
          .then((result) => Boolean(result.vehicle))
          .catch(() => false),
      ),
    );

    await Promise.all(clients.map((client) => client.$disconnect()));

    const created = attempts.filter(Boolean).length;

    // Exactly one slot was left.
    expect(created).toBe(1);

    expect(
      await prisma.vehicle.count({
        where: { businessId: CARRIER, status: { not: "INACTIVE" } },
      }),
    ).toBe(10);
  });

  it("allows creating when there is a slot", async () => {
    await prisma.vehicle.deleteMany({ where: { businessId: CARRIER } });

    const result = await vehicles.createVehicleWithinLimit(
      vehicleData("livre"),
      { max: 10, occupiesSlot: true },
    );

    expect(result.vehicle).not.toBeNull();
  });

  it("ignores the limit for a vehicle that takes no slot", async () => {
    await prisma.vehicle.deleteMany({ where: { businessId: CARRIER } });

    for (let n = 0; n < 10; n += 1) {
      await prisma.vehicle.create({ data: vehicleData(`cheio${n}`) });
    }

    // Registering straight as INACTIVE is legitimate even with a full fleet:
    // it takes no slot, and activating later goes through the reactivation
    // gate.
    const result = await vehicles.createVehicleWithinLimit(
      { ...vehicleData("inativo"), status: "INACTIVE" },
      { max: 10, occupiesSlot: false },
    );

    expect(result.vehicle).not.toBeNull();
  });
});

describe("deleting an account while it is being paid", () => {
  it("is refused once the payment is stamped", async () => {
    const payable = await prisma.accountPayable.create({
      data: {
        businessId: CARRIER,
        branchId,
        registrationUserId: userId,
        due_date: new Date(),
        amount: 1500,
        category: "OTHER",
      } as never,
    });

    await prisma.accountPayable.update({
      where: { id: payable.id },
      data: { payment_date: new Date(), amount_paid: 1500 },
    });

    await expect(
      payables.deleteAccountPayable(payable.id, CARRIER),
    ).rejects.toThrow();

    // A settled financial record does not disappear.
    expect(
      await prisma.accountPayable.count({ where: { id: payable.id } }),
    ).toBe(1);
  });

  it("deletes an account that is still open", async () => {
    const payable = await prisma.accountPayable.create({
      data: {
        businessId: CARRIER,
        branchId,
        registrationUserId: userId,
        due_date: new Date(),
        amount: 900,
        category: "OTHER",
      } as never,
    });

    await payables.deleteAccountPayable(payable.id, CARRIER);

    expect(
      await prisma.accountPayable.count({ where: { id: payable.id } }),
    ).toBe(0);
  });

  it("does not delete another company’s account", async () => {
    const payable = await prisma.accountPayable.create({
      data: {
        businessId: CARRIER,
        branchId,
        registrationUserId: userId,
        due_date: new Date(),
        amount: 100,
        category: "OTHER",
      } as never,
    });

    await expect(
      payables.deleteAccountPayable(payable.id, randomUUID()),
    ).rejects.toThrow();

    expect(
      await prisma.accountPayable.count({ where: { id: payable.id } }),
    ).toBe(1);
  });
});

describe("deleting MASTERs at the same time", () => {
  /**
   * MASTER is the only role that creates another MASTER.
   *
   * Counting and then deleting does not work: two simultaneous requests
   * deleting DIFFERENT MASTERs both read `total = 2`, both pass the gate, and
   * zero are left — the platform locked from the outside, with no way back in
   * through the application itself.
   */
  const masters: string[] = [];

  async function seedMaster(): Promise<string> {
    const user = await prisma.user.create({
      data: {
        name: "Master",
        email: `master-corrida-${randomUUID()}@exemplo.com.br`,
        password: "nao-usado",
        role: "MASTER",
      },
    });

    masters.push(user.id);

    return user.id;
  }

  it("never leaves the platform without one", async () => {
    // The state that matters: EXACTLY two. How many already exist in the
    // database is not controllable here, so the assertion is about never
    // reaching zero.
    const before = await prisma.user.count({ where: { role: "MASTER" } });

    const needed = Math.max(0, 2 - before);

    for (let n = 0; n < needed; n += 1) await seedMaster();

    const all = await prisma.user.findMany({
      where: { role: "MASTER" },
      select: { id: true },
    });

    // Separate connections, for the same reason as the fleet limit: with a
    // cliente só as chamadas serializam por acidente.
    const clients = all.map(() => new PrismaClient());

    await Promise.all(
      all.map((master, index) =>
        new UserRepository(clients[index])
          .deleteMasterUserKeepingOne(master.id)
          .catch(() => null),
      ),
    );

    await Promise.all(clients.map((client) => client.$disconnect()));

    // Um sobra. Sempre.
    expect(
      await prisma.user.count({ where: { role: "MASTER" } }),
    ).toBeGreaterThanOrEqual(1);
  });

  it("refuses when only one is left", async () => {
    const remaining = await prisma.user.findFirstOrThrow({
      where: { role: "MASTER" },
    });

    const count = await prisma.user.count({ where: { role: "MASTER" } });

    if (count === 1) {
      expect(
        await new UserRepository().deleteMasterUserKeepingOne(remaining.id),
      ).toBeNull();
    }
  });

  it("refuses an id that is not a MASTER", async () => {
    // Not a silent no-op: the target has to be among the locked rows.
    const plain = await prisma.user.findFirstOrThrow({
      where: { businessId: CARRIER, role: "BUSINESS_ADMIN" },
    });

    expect(
      await new UserRepository().deleteMasterUserKeepingOne(plain.id),
    ).toBeNull();

    expect(await prisma.user.count({ where: { id: plain.id } })).toBe(1);
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: masters } } });
  });
});
