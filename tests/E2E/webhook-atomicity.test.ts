import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";

import { DeliveryRepository } from "@/modules/delivery/repositories/delivery-repository";

/**
 * A webhook row and the fact it describes commit together, or neither does.
 *
 * The unit suite proves each use case HANDS its transaction to the fan-out —
 * that is what the recording fake can see. What it cannot see is whether the
 * repositories underneath honour it: a Prisma method that opens its own
 * `$transaction` while already inside one does not nest, it takes a second
 * connection, and the write it makes commits on its own no matter what the
 * caller does afterwards. That failure is invisible without a real database,
 * which is why it is tested here.
 */
const prisma = new PrismaClient();

const CARRIER = "018f7000-0000-7000-8000-00000000000a";
const SHIPPER = "018f7000-0000-7000-8000-0000000000f1";
const DRIVER = "018f7000-0000-7000-8000-0000000000d1";

const repository = new DeliveryRepository();

let pending: string[] = [];

async function seedDelivery(name: string): Promise<string> {
  const created = await prisma.delivery.create({
    data: {
      recipient_name: name,
      city: "São Paulo",
      uf: "SP",
      street: "Rua Um",
      businessId: CARRIER,
      shipperId: SHIPPER,
      status: "PENDING",
    },
  });

  return created.id;
}

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora Atômica",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua das Transportadoras",
      address_number: "1",
      cnpj: "11222888000199",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: "atomica@exemplo.com.br",
    },
  });

  await prisma.shipper.create({
    data: { id: SHIPPER, name: "Embarcador", businessId: CARRIER },
  });

  await prisma.driver.create({
    data: {
      id: DRIVER,
      name: "Motorista",
      birth_date: new Date("1990-01-01"),
      cnh: "cnh-atomicity",
      cpf: "cpf-atomicity",
      rg: "rg-atomicity",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId: CARRIER,
    },
  });

  pending = [await seedDelivery("Primeira"), await seedDelivery("Segunda")];
}, 90_000);

afterAll(async () => {
  await prisma.delivery.deleteMany({ where: { businessId: CARRIER } });
  await prisma.driver.deleteMany({ where: { businessId: CARRIER } });
  await prisma.shipper.deleteMany({ where: { businessId: CARRIER } });
  await prisma.business.deleteMany({ where: { id: CARRIER } });

  await prisma.$disconnect();
});

describe("a repository write joins the caller's transaction", () => {
  it("rolls the batch assignment back with the transaction around it", async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await repository.assignDeliveries(
          pending,
          { driverId: DRIVER, vehicleId: null },
          tx,
        );

        // Stands in for the webhook row failing to write: whatever goes wrong
        // after the assignment, the assignment has to go with it.
        throw new Error("o evento não pôde ser enfileirado");
      }),
    ).rejects.toThrow("o evento não pôde ser enfileirado");

    const after = await prisma.delivery.findMany({
      where: { id: { in: pending } },
      select: { id: true, driverId: true, status: true },
    });

    // Opening its own transaction instead of joining this one would have
    // committed the driver onto both documents while the caller rolled back —
    // two trucks assigned to a load nobody announced.
    expect(after.map((row) => row.driverId)).toEqual([null, null]);
  });

  it("keeps the assignment when the transaction commits", async () => {
    // The other half of the pair. Without it the test above passes for a
    // repository that simply never assigns anything.
    await prisma.$transaction(async (tx) => {
      await repository.assignDeliveries(
          pending,
          { driverId: DRIVER, vehicleId: null },
          tx,
        );
    });

    const after = await prisma.delivery.findMany({
      where: { id: { in: pending } },
      select: { driverId: true },
    });

    expect(after.map((row) => row.driverId)).toEqual([DRIVER, DRIVER]);
  });

  it("rolls a created delivery back with the transaction around it", async () => {
    const before = await prisma.delivery.count({
      where: { businessId: CARRIER },
    });

    await expect(
      prisma.$transaction(async (tx) => {
        await repository.createDelivery(
          {
            recipient_name: "Nunca existiu",
            city: "São Paulo",
            uf: "SP",
            street: "Rua Dois",
            businessId: CARRIER,
            shipperId: SHIPPER,
          } as never,
          tx,
        );

        throw new Error("o evento não pôde ser enfileirado");
      }),
    ).rejects.toThrow("o evento não pôde ser enfileirado");

    expect(
      await prisma.delivery.count({ where: { businessId: CARRIER } }),
    ).toBe(before);
  });
});
