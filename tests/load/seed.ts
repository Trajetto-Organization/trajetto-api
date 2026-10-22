import { PrismaClient } from "@prisma/client";

import { randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { hash } from "bcrypt";
import { sign } from "jsonwebtoken";

import auth from "../../src/config/auth";
import { ensureDefaultOccurrenceTypes } from "../../src/shared/delivery/default-occurrence-types";
import { generateApiKey } from "../../src/shared/integration/api-key-rules";
import {
  businessDateKey,
  dateOnlyFromKey,
} from "../../src/shared/time/business-day";
import { assertDisposableDatabase } from "./lib/disposable-database";

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
 * Drivers of the tenant the load points at, when it needs more than the rest.
 *
 * The position ingest allows 120 calls a minute per driver and every other
 * route 300 per user: the reference peak (~500 req/s, a third of it pings) over
 * forty drivers is several calls a second each, so a run at that rate measured
 * the limiter. Raising LOAD_DRIVERS instead multiplied every tenant's fleet.
 */
const PRIMARY_DRIVERS = Number(
  process.env.LOAD_PRIMARY_DRIVERS ?? DRIVERS_PER_TENANT,
);

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

/**
 * Months of finished work for the primary tenant. Off by default.
 *
 * The default dataset is forty tenants of five hundred deliveries, all created
 * the moment the seed ran, with no events and no occurrences: every query whose
 * cost grows with a carrier's AGE — the listing's counts, the dashboard's
 * "today", the tower's latest events, the exports — was measured against a
 * company born that morning, and the per-replica ruler in the README came from
 * there. LOAD_PRIMARY_DELIVERIES adds that many deliveries to the tenant the
 * load points at, spread over the LOAD_PRIMARY_HISTORY_DAYS before today, with
 * two events each and an occurrence on one in twenty: a carrier after a season.
 */
const PRIMARY_HISTORY = Math.max(
  0,
  Math.floor(Number(process.env.LOAD_PRIMARY_DELIVERIES ?? 0)),
);
const PRIMARY_HISTORY_DAYS = Math.max(
  1,
  Math.floor(Number(process.env.LOAD_PRIMARY_HISTORY_DAYS ?? 180)),
);

// Overridable so a check of the seed itself does not overwrite the context a
// load environment is using.
const OUT = process.env.LOAD_CONTEXT_OUT
  ? resolve(process.env.LOAD_CONTEXT_OUT)
  : resolve(__dirname, "fixtures", "load-context.json");

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

/**
 * The same claims `issueSessionTokenPair` puts in a real access token.
 *
 * Not only `sub` and the session fields: the WEB reads `role`, `businessId`
 * and `driverId` out of the token and compares them against `/user/me` on
 * every navigation — a mismatch is treated as "your permissions changed" and
 * logs the session out.
 *
 * Found by a browser test that passed against the LOGIN page: eleven widths of
 * a screen nobody was measuring.
 */
function tokenFor(
  userId: string,
  familyId: string,
  claims: { role: string; businessId: string | null; driverId: string | null },
): string {
  return sign(
    {
      tokenType: "access",
      role: claims.role,
      businessId: claims.businessId,
      driverId: claims.driverId,
      sessionVersion: 0,
      familyId,
    },
    auth.secret_token,
    { subject: userId, expiresIn: "12h" },
  );
}

/**
 * The history, in three statements: row-by-row through Prisma this would be
 * hours for a few hundred thousand deliveries. Everything ends before today,
 * so the panels about TODAY keep reading a day's worth of rows — the point is
 * to find the queries that read the rest anyway.
 */
async function seedHistory(
  businessId: string,
  shipperId: string,
  driverIds: string[],
  reporterId: string,
): Promise<void> {
  if (PRIMARY_HISTORY === 0) return;

  console.log(
    `[Load] Histórico do tenant principal: ${PRIMARY_HISTORY} entregas em ${PRIMARY_HISTORY_DAYS} dias…`,
  );

  // One in twenty-five failed; the rest were delivered two hours after
  // being created. Spread uniformly over the window, ending yesterday.
  await prisma.$executeRawUnsafe(
    `
    INSERT INTO "delivery" (
      "id", "recipient_name", "code", "city", "uf", "street", "address_number",
      "status", "businessId", "shipperId", "driverId", "kind",
      "created_at", "updated_at", "delivered_at"
    )
    SELECT
      gen_random_uuid()::text, 'Histórico ' || n, 'HIS-' || n, 'São Paulo', 'SP',
      'Rua do Destino', n::text,
      (CASE WHEN n % 25 = 0 THEN 'FAILED' ELSE 'DELIVERED' END)::"DeliveryStatus",
      $1, $2, ($3::text[])[1 + n % cardinality($3::text[])], 'DELIVERY'::"DeliveryKind",
      at, at + interval '2 hours',
      CASE WHEN n % 25 = 0 THEN NULL ELSE at + interval '2 hours' END
    FROM (
      SELECT n,
             date_trunc('day', now()) - interval '1 day'
               - random() * interval '${PRIMARY_HISTORY_DAYS - 1} days' AS at
      FROM generate_series(1, ${PRIMARY_HISTORY}) AS n
    ) AS history
    `,
    businessId,
    shipperId,
    driverIds,
  );

  await prisma.$executeRawUnsafe(
    `
    INSERT INTO "delivery_event" ("id", "type", "deliveryId", "businessId", "created_at")
    SELECT gen_random_uuid()::text, step.type::"DeliveryEventType", d."id",
           d."businessId", d."created_at" + step.after
    FROM "delivery" d
    CROSS JOIN (
      VALUES ('ARRIVAL', interval '90 minutes'), ('PROOF', interval '2 hours')
    ) AS step(type, after)
    WHERE d."businessId" = $1 AND d."code" LIKE 'HIS-%'
    `,
    businessId,
  );

  const occurrenceType = await prisma.occurrenceType.create({
    data: { name: "Destinatário ausente", businessId },
  });

  await prisma.$executeRawUnsafe(
    `
    INSERT INTO "delivery_occurrence" (
      "id", "deliveryId", "businessId", "occurrenceTypeId", "reportedById",
      "created_at", "updated_at"
    )
    SELECT gen_random_uuid()::text, d."id", d."businessId", $2, $3,
           d."created_at" + interval '1 hour', d."created_at" + interval '1 hour'
    FROM "delivery" d
    WHERE d."businessId" = $1
      AND d."code" LIKE 'HIS-%'
      AND substring(d."code" FROM 5)::int % 20 = 0
    `,
    businessId,
    occurrenceType.id,
    reporterId,
  );

  // Without fresh statistics the planner would plan for the table as it was
  // before the insert, and the load would measure a plan nobody gets.
  for (const table of ["delivery", "delivery_event", "delivery_occurrence"]) {
    await prisma.$executeRawUnsafe(`ANALYZE "${table}"`);
  }
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

  const driversHere = primary ? PRIMARY_DRIVERS : DRIVERS_PER_TENANT;

  for (let n = 0; n < driversHere; n += 1) {
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

      driverTokens.push(
        tokenFor(userId, familyId, {
          role: "BUSINESS_USER",
          businessId,
          driverId: driver.id,
        }),
      );
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
  const managerIds: string[] = [];

  for (let n = 0; n < MANAGERS; n += 1) {
    const managerId = randomUUID();
    const managerFamily = randomUUID();

    managerIds.push(managerId);

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

    managerTokens.push(
      tokenFor(managerId, managerFamily, {
        role: "BUSINESS_ADMIN",
        businessId,
        driverId: null,
      }),
    );
  }

  // The first manager reported the historical occurrences: the column is
  // required, and who it was does not matter to any query measured.
  if (managerIds.length > 0) {
    await seedHistory(businessId, shipper.id, driverIds, managerIds[0]);
  }

  const key = generateApiKey();

  await prisma.apiKey.create({
    data: {
      name: "Carga",
      prefix: key.prefix,
      token_hash: key.tokenHash,
      scopes: [
        "deliveries:read",
        "deliveries:write",
        "routes:read",
        "events:read",
      ],
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

/**
 * The app's Maestro suite (trajetto-mobile/docs/testes.md) logs in through the
 * form, so it needs real credentials rather than minted tokens: a driver of a
 * company with Frota and Entregas, a route RELEASED for the company's business
 * day with three stops, and a second driver whose company has no Frota (the
 * module gating flow), plus a third driver with two-factor on (the code flow).
 * Same disposable container, a database of its own.
 */
const MOBILE_E2E = process.env.LOAD_MOBILE_E2E === "1";
const MOBILE_E2E_PASSWORD =
  process.env.MOBILE_E2E_PASSWORD ?? "Motorista@E2E2026";

const MOBILE_E2E_OUT = process.env.LOAD_CONTEXT_OUT
  ? resolve(process.env.LOAD_CONTEXT_OUT)
  : resolve(__dirname, "fixtures", "mobile-e2e.json");

async function seedMobileCompany(options: {
  label: string;
  cnpj: string;
  email: string;
  fleet: boolean;
  deliveries: number;
  /** The plate of the driver's vehicle (unique per company only). */
  plate: string;
  /** Login stops at the e-mailed code (the two-factor flow). */
  twoFactor?: boolean;
}): Promise<{ businessId: string; driverId: string; routeId: string }> {
  const businessId = randomUUID();
  const timeZone = "America/Sao_Paulo";

  await prisma.business.create({
    data: {
      id: businessId,
      corporate_reason: `Transportadora ${options.label}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua da Carga",
      address_number: "1",
      cnpj: options.cnpj,
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `empresa-${randomUUID()}@exemplo.com.br`,
      vehicle_limit: 10,
      timezone: timeZone,
    },
  });

  await prisma.businessEntitlement.createMany({
    data: [
      { businessId, module: "DELIVERIES", enabled: true },
      ...(options.fleet
        ? [{ businessId, module: "FLEET" as const, enabled: true }]
        : []),
    ],
  });

  // Delivered, pause and the other default types, as a company created through
  // the API gets them (the list would seed them lazily anyway).
  await ensureDefaultOccurrenceTypes(prisma, businessId);

  // Not-delivered types are the company's own (none ship by default): one
  // plain, one with a form (a required text and a Sim/Não) for the flow that
  // fills a form field on the phone.
  await prisma.occurrenceType.createMany({
    data: [
      {
        name: "Cliente ausente",
        description: "Ninguém atendeu no endereço.",
        category: "NOT_DELIVERED",
        businessId,
      },
      {
        name: "Avaria na carga",
        description: "A mercadoria chegou danificada.",
        category: "NOT_DELIVERED",
        form_fields: [
          {
            key: "volumes_avariados",
            label: "Volumes avariados",
            type: "text",
            required: true,
          },
          {
            key: "cliente_recusou",
            label: "Cliente recusou",
            type: "boolean",
            required: false,
          },
        ],
        businessId,
      },
    ],
  });

  const branch = await prisma.branch.create({
    data: {
      corporate_reason: `Filial ${options.label}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: `${options.cnpj.slice(0, 8)}0002${options.cnpj.slice(-2)}`,
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `filial-${randomUUID()}@exemplo.com.br`,
      businessId,
    },
  });

  const driver = await prisma.driver.create({
    data: {
      name: `Motorista ${options.label}`,
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
      businessId,
      branchId: branch.id,
    },
  });

  const vehicleType = await prisma.vehicleType.create({
    data: { description: "Caminhão toco", number_of_axles: 2, businessId },
  });

  const fuelType = await prisma.fuelType.create({
    data: { description: "Diesel S10", businessId },
  });

  // Starting a route needs a vehicle linked to the driver.
  const vehicle = await prisma.vehicle.create({
    data: {
      license_plate: options.plate,
      description: "Caminhão do E2E",
      brand: "Volvo",
      model: "VM",
      acquisition_date: new Date("2020-01-01"),
      fleet_type: "OWNED",
      current_mileage: 50_000,
      maintenance_interval_km: 10_000,
      maintenance_interval_months: 6,
      renavam: randomUUID().slice(0, 11),
      manufacturing_year: new Date("2019-01-01"),
      model_year: new Date("2020-01-01"),
      km_per_liter: 3,
      number_of_axles: 2,
      status: "ACTIVE",
      businessId,
      branchId: branch.id,
      vehicleTypeId: vehicleType.id,
      fuelTypeId: fuelType.id,
      driverId: driver.id,
    },
  });

  await prisma.user.create({
    data: {
      name: `Motorista ${options.label}`,
      email: options.email,
      password: await hash(MOBILE_E2E_PASSWORD, 6),
      role: "BUSINESS_USER",
      email_verified: new Date(),
      businessId,
      driverId: driver.id,
      two_factor_enabled: options.twoFactor ?? false,
    },
  });

  const shipper = await prisma.shipper.create({
    data: { name: "Embarcador E2E", businessId },
  });

  // RELEASED for the company's business day: what the dispatcher hands over in
  // the morning, before the driver presses "Iniciar rota".
  const route = await prisma.route.create({
    data: {
      code: 101,
      name: `Rota E2E ${options.label}`,
      status: "RELEASED",
      scheduled_date: dateOnlyFromKey(businessDateKey(new Date(), timeZone)),
      released_at: new Date(),
      businessId,
      driverId: driver.id,
      vehicleId: vehicle.id,
    },
  });

  const deliveries = Array.from({ length: options.deliveries }, (_, n) => ({
    id: randomUUID(),
    recipient_name: `Cliente E2E ${n + 1}`,
    code: `E2E-${n + 1}`,
    city: "São Paulo",
    uf: "SP",
    street: "Avenida Paulista",
    address_number: String(1000 + n),
    businessId,
    shipperId: shipper.id,
    driverId: driver.id,
    status: "PENDING" as const,
  }));

  await prisma.delivery.createMany({ data: deliveries });

  await prisma.routeStop.createMany({
    data: deliveries.map((delivery, n) => ({
      routeId: route.id,
      deliveryId: delivery.id,
      sequence: n + 1,
      status: "PENDING" as const,
    })),
  });

  return { businessId, driverId: driver.id, routeId: route.id };
}

async function seedMobileE2E(): Promise<void> {
  const fleet = await seedMobileCompany({
    label: "E2E Frota",
    cnpj: "11222333000181",
    email: process.env.MOBILE_E2E_EMAIL ?? "motorista.e2e@trajetto.test",
    fleet: true,
    deliveries: 3,
    plate: "E2E1A23",
  });

  const deliveriesOnly = await seedMobileCompany({
    label: "E2E Sem Frota",
    cnpj: "44555666000181",
    email:
      process.env.MOBILE_E2E_NOFLEET_EMAIL ??
      "motorista.semfrota@trajetto.test",
    fleet: false,
    deliveries: 1,
    plate: "E2E9Z99",
  });

  // A company of its own, so its stop never shows up in the other flows.
  const twoFactor = await seedMobileCompany({
    label: "E2E Dois Fatores",
    cnpj: "77888999000181",
    email: process.env.MOBILE_E2E_TWOFA_EMAIL ?? "motorista.2fa@trajetto.test",
    fleet: false,
    deliveries: 1,
    plate: "E2E2F22",
    twoFactor: true,
  });

  mkdirSync(dirname(MOBILE_E2E_OUT), { recursive: true });

  // Ids only: the password is the one this process was given (or the default
  // documented in trajetto-mobile/docs/testes.md), never written to disk.
  writeFileSync(
    MOBILE_E2E_OUT,
    JSON.stringify({ fleet, deliveriesOnly, twoFactor }, null, 2),
    "utf8",
  );

  console.log(`[Mobile E2E] Fixture escrita em ${MOBILE_E2E_OUT}`);
}

async function main(): Promise<void> {
  assertDisposableDatabase();

  if (MOBILE_E2E) {
    await seedMobileE2E();
    await prisma.$disconnect();
    return;
  }

  // The seed assumes an empty load_test (fixed company names are unique). A
  // second run used to die on a raw P2002 halfway through tenant 0; say what
  // to do instead.
  const alreadySeeded = await prisma.business.findFirst({
    where: { corporate_reason: "Transportadora de carga 0" },
    select: { id: true },
  });

  if (alreadySeeded) {
    throw new Error(
      "O load_test já foi semeado. Para novos tokens das sessões rode só " +
        "mint-master.ts e mint-browser-users.ts; para semear de novo, recrie o " +
        "banco (dropdb/createdb load_test + prisma migrate deploy). Veja " +
        "trajetto-ui/tests/ui/README.md, passo 2.",
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
