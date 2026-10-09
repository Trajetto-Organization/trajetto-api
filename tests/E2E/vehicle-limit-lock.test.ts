import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { VehicleRepository } from "@/modules/vehicle/repositories/vehicle-repository";

/**
 * What registering a vehicle locks, and who else waits for it.
 *
 * The contracted-fleet check serialises vehicle registrations per company by
 * locking the company's row (write-preconditions.test.ts proves the limit
 * holds under a race). It took that lock FOR UPDATE — the one mode that also
 * conflicts with the FOR KEY SHARE every insert with a foreign key to
 * `business` takes on its parent. So while a vehicle was being registered,
 * every proof, delivery, route, activity and notification of that company
 * queued behind it. FOR NO KEY UPDATE still conflicts with itself, so the
 * registrations keep serialising, and it leaves those inserts alone.
 *
 * The lock statement is captured from the repository as it runs, then held
 * open in one session while another inserts a row that references the
 * company, with a short lock_timeout so a block shows up as an error instead
 * of a hang.
 */
const prisma = new PrismaClient();

const counted = new PrismaClient({
  log: [{ level: "query", emit: "event" }],
});

const CARRIER = "018fe060-0000-7000-8000-00000000000a";

const statements: string[] = [];

let fuelTypeId = "";

beforeAll(async () => {
  counted.$on("query" as never, (event: { query: string }) => {
    statements.push(event.query);
  });

  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora da Frota Contratada",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(59000000000000 + Math.floor(Math.random() * 9000000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `frota-${randomUUID()}@exemplo.com.br`,
      vehicle_limit: 10,
    },
  });

  fuelTypeId = (
    await prisma.fuelType.create({
      data: { description: "Diesel", businessId: CARRIER },
    })
  ).id;
}, 120_000);

afterAll(async () => {
  await prisma.shipper.deleteMany({ where: { businessId: CARRIER } });
  await prisma.vehicle.deleteMany({ where: { businessId: CARRIER } });
  await prisma.fuelType.deleteMany({ where: { businessId: CARRIER } });
  await prisma.business.deleteMany({ where: { id: CARRIER } });

  await prisma.$disconnect();
  await counted.$disconnect();
});

describe("registering a vehicle within the contracted fleet", () => {
  it("does not hold up the company's other inserts while it counts", async () => {
    await new VehicleRepository(counted).createVehicleWithinLimit(
      {
        description: "Caminhão",
        license_plate: "LCK1B23",
        brand: "Volvo",
        model: "FH",
        acquisition_date: new Date(),
        fleet_type: "OWNED",
        current_mileage: 0,
        maintenance_interval_km: 10000,
        maintenance_interval_months: 6,
        renavam: `lock-${randomUUID().slice(0, 8)}`,
        manufacturing_year: new Date(),
        model_year: new Date(),
        km_per_liter: 3,
        number_of_axles: 3,
        status: "ACTIVE",
        businessId: CARRIER,
        fuelTypeId,
      } as never,
      { max: 10, occupiesSlot: true },
    );

    const lock = statements.find(
      (sql) => /FROM\s+"business"/.test(sql) && /\bFOR\b/.test(sql),
    );

    expect(lock, statements.join("\n")).toBeDefined();

    // The same statement, held open in one session...
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });

    let held: () => void = () => undefined;
    const holding = new Promise<void>((resolve) => {
      held = resolve;
    });

    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$queryRawUnsafe(lock!, CARRIER);
        held();
        await released;
      },
      { maxWait: 10_000, timeout: 20_000 },
    );

    await holding;

    // ...while the company's ordinary work goes on in another. A foreign key
    // to `business` takes FOR KEY SHARE on the company's row.
    const insert = await prisma
      .$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '1s'");

        await tx.shipper.create({
          data: { name: `Embarcador ${randomUUID()}`, businessId: CARRIER },
        });
      })
      .then(
        () => null,
        (error: unknown) => error,
      );

    release();
    await holder;

    // Under FOR UPDATE this was 55P03 (lock_not_available) after a second.
    expect(insert, String(insert)).toBeNull();
  });
});
