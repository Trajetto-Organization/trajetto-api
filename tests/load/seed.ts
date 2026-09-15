import { PrismaClient } from "@prisma/client";

import { randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { sign } from "jsonwebtoken";

import auth from "../../src/config/auth";
import { generateApiKey } from "../../src/shared/integration/api-key-rules";

/**
 * The dataset the load scripts run against.
 *
 * Sized from the capacity ruler rather than from convenience: the reference
 * operation is 5M deliveries a month across 3.600 carriers, which makes
 * `businessId` the dominant factor in every index. A load test against ONE
 * tenant's worth of rows measures a database that does not exist — the planner
 * picks different plans when a `businessId` matches 100% of a table than when
 * it matches 0,03% of it.
 *
 * So this seeds many tenants with rows, and points the load at one of them.
 *
 * Writes into the throwaway container, never the developer's database. The
 * connection string is required rather than defaulted for exactly that reason.
 */
const prisma = new PrismaClient();

const TENANTS = Number(process.env.LOAD_TENANTS ?? 40);
const DELIVERIES_PER_TENANT = Number(process.env.LOAD_DELIVERIES ?? 500);
const DRIVERS_PER_TENANT = Number(process.env.LOAD_DRIVERS ?? 10);

/**
 * How many people of the primary tenant the load pretends to be.
 *
 * Not one. The rate limiter keys on the USER, so a run that sent every
 * dispatcher request with the same token would measure the rate limiter and
 * call it capacity — which is exactly what the first run of this suite did:
 * 55% of requests answered 429 at a p95 of 14ms, a server doing nothing while
 * the test declared it overloaded.
 */
const MANAGERS = Number(process.env.LOAD_MANAGERS ?? 50);

const OUT = resolve(__dirname, "fixtures", "load-context.json");

interface LoadContext {
  baseUrl: string;

  businessId: string;

  managerTokens: string[];
  driverTokens: string[];

  apiKey: string;

  deliveryIds: string[];
  driverIds: string[];
  routeIds: string[];
}

function tokenFor(userId: string, familyId: string): string {
  return sign(
    { tokenType: "access", sessionVersion: 0, familyId },
    auth.secret_token,
    { subject: userId, expiresIn: "12h" },
  );
}

async function seedTenant(index: number, primary: boolean) {
  const businessId = randomUUID();

  await prisma.business.create({
    data: {
      id: businessId,
      corporate_reason: `Transportadora de carga ${index}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua da Carga",
      address_number: String(index),
      cnpj: String(20000000000000 + index),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `carga-${index}-${randomUUID()}@exemplo.com.br`,
    },
  });

  await prisma.businessEntitlement.create({
    data: { businessId, module: "DELIVERIES", enabled: true },
  });

  const shipper = await prisma.shipper.create({
    data: { name: `Embarcador ${index}`, businessId },
  });

  const fuelType = await prisma.fuelType.create({
    data: { description: "Diesel", businessId },
  });

  const driverIds: string[] = [];
  const driverTokens: string[] = [];

  const routeIds: string[] = [];

  for (let n = 0; n < DRIVERS_PER_TENANT; n += 1) {
    const driver = await prisma.driver.create({
      data: {
        name: `Motorista ${index}-${n}`,
        birth_date: new Date("1990-01-01"),
        cnh: `cnh-${index}-${n}-${randomUUID().slice(0, 8)}`,
        cpf: `cpf-${index}-${n}-${randomUUID().slice(0, 8)}`,
        rg: `rg-${index}-${n}-${randomUUID().slice(0, 8)}`,
        cep: "01001000",
        city: "São Paulo",
        uf: "SP",
        street: "Rua",
        address_number: "1",
        status: "ACTIVE",
        contract_type: "OWNED",
        businessId,
      },
    });

    driverIds.push(driver.id);

    const vehicle = await prisma.vehicle.create({
      data: {
        description: "Caminhão",
        license_plate: `L${index}D${n}${randomUUID().slice(0, 4)}`.slice(0, 10),
        brand: "Volvo",
        model: "FH",
        acquisition_date: new Date(),
        fleet_type: "OWNED",
        current_mileage: 0,
        maintenance_interval_km: 10000,
        maintenance_interval_months: 6,
        renavam: `rnv-${index}-${n}-${randomUUID().slice(0, 8)}`,
        manufacturing_year: new Date(),
        model_year: new Date(),
        km_per_liter: 3,
        number_of_axles: 3,
        status: "ACTIVE",
        businessId,
        driverId: driver.id,
        fuelTypeId: fuelType.id,
      },
    });

    // A route IN PROGRESS, because the position ingest only writes while one
    // is — and that ingest is the heaviest write on the platform.
    const route = await prisma.route.create({
      data: {
        code: index * 1000 + n,
        name: `Rota ${index}-${n}`,
        status: "IN_PROGRESS",
        scheduled_date: new Date(),
        planned_departure_at: new Date(Date.now() - 2 * 60 * 60 * 1000),
        started_at: new Date(Date.now() - 100 * 60 * 1000),
        businessId,
        driverId: driver.id,
        vehicleId: vehicle.id,
      },
    });

    routeIds.push(route.id);

    if (primary) {
      const userId = randomUUID();
      const familyId = randomUUID();

      await prisma.user.create({
        data: {
          id: userId,
          name: `Motorista ${n}`,
          email: `driver-${n}-${randomUUID()}@exemplo.com.br`,
          password: "nao-usado",
          role: "BUSINESS_USER",
          businessId,
          driverId: driver.id,
        },
      });

      await prisma.refreshToken.create({
        data: {
          userId,
          token_hash: randomUUID(),
          jti: randomUUID(),
          family_id: familyId,
          expires_in: new Date(Date.now() + 12 * 60 * 60 * 1000),
        },
      });

      driverTokens.push(tokenFor(userId, familyId));
    }
  }

  // Deliveries in one batch per tenant: seeding a hundred thousand rows one
  // round trip at a time is an hour of waiting before any measurement starts.
  const deliveries = Array.from({ length: DELIVERIES_PER_TENANT }, (_, n) => ({
    id: randomUUID(),
    recipient_name: `Cliente ${index}-${n}`,
    code: `PED-${index}-${n}`,
    city: "São Paulo",
    uf: "SP",
    street: "Rua do Destino",
    address_number: String(n),
    businessId,
    shipperId: shipper.id,
    driverId: driverIds[n % driverIds.length],
    status: (["PENDING", "IN_TRANSIT", "DELIVERED"] as const)[n % 3],
  }));

  await prisma.delivery.createMany({ data: deliveries });

  // Stops, so the route reads the way the app expects. One per delivery of
  // the first driver only: the point is a realistic route, not a full board.
  const stopDeliveries = deliveries.filter(
    (delivery) => delivery.driverId === driverIds[0],
  );

  await prisma.routeStop.createMany({
    data: stopDeliveries.slice(0, 25).map((delivery, n) => ({
      routeId: routeIds[0],
      deliveryId: delivery.id,
      sequence: n + 1,
      status: "PENDING" as const,
    })),
  });

  if (!primary) {
    return null;
  }

  const managerTokens: string[] = [];

  for (let n = 0; n < MANAGERS; n += 1) {
    const managerId = randomUUID();
    const managerFamily = randomUUID();

    await prisma.user.create({
      data: {
        id: managerId,
        name: `Gestora de carga ${n}`,
        email: `manager-${n}-${randomUUID()}@exemplo.com.br`,
        password: "nao-usado",
        role: "BUSINESS_ADMIN",
        businessId,
      },
    });

    await prisma.refreshToken.create({
      data: {
        userId: managerId,
        token_hash: randomUUID(),
        jti: randomUUID(),
        family_id: managerFamily,
        expires_in: new Date(Date.now() + 12 * 60 * 60 * 1000),
      },
    });

    managerTokens.push(tokenFor(managerId, managerFamily));
  }

  const key = generateApiKey();

  await prisma.apiKey.create({
    data: {
      name: "Carga",
      prefix: key.prefix,
      token_hash: key.tokenHash,
      scopes: ["deliveries:read", "deliveries:write", "routes:read", "events:read"],
      rate_limit_per_minute: 6000,
      businessId,
    },
  });

  return {
    businessId,
    managerTokens,
    driverTokens,
    apiKey: key.token,
    deliveryIds: deliveries.slice(0, 200).map((delivery) => delivery.id),
    driverIds,
    routeIds,
  };
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL?.includes("54321")) {
    throw new Error(
      "A carga só roda contra o container descartável (porta 54321). " +
        "Aponte DATABASE_URL para ele.",
    );
  }

  console.log(
    `[Load] Semeando ${TENANTS} tenants × ${DELIVERIES_PER_TENANT} entregas…`,
  );

  let primary: Awaited<ReturnType<typeof seedTenant>> = null;

  for (let index = 0; index < TENANTS; index += 1) {
    const result = await seedTenant(index, index === 0);

    if (result) primary = result;

    if ((index + 1) % 10 === 0) {
      console.log(`[Load] ${index + 1}/${TENANTS} tenants`);
    }
  }

  if (!primary) throw new Error("O tenant principal não foi semeado.");

  const context: LoadContext = {
    baseUrl: process.env.LOAD_BASE_URL ?? "http://host.docker.internal:3334",
    ...primary,
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(context, null, 2), "utf8");

  console.log(`[Load] Contexto escrito em ${OUT}`);

  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);

  await prisma.$disconnect();
  process.exit(1);
});
