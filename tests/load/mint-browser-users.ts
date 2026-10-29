import { createPrismaClient } from "@/shared/database/database-client";
/**
 * Real people for the browser suite: accounts that sign in through the FORM.
 *
 * `mint-master.ts` signs tokens and drops them in a cookie, which is right for
 * a spec about a screen and wrong for a spec about getting IN: the login form,
 * the wrong-password refusal, the two-factor step, where each role lands and
 * what logging out clears were never exercised by a browser, because nobody
 * in the load fixture had a password (decision 13.3).
 *
 *   DATABASE_URL="...load_test..." npx tsx tests/load/mint-browser-users.ts
 *
 * Writes `fixtures/browser-users.json` with e-mails and ids only. The password
 * is the one this process was given (WEB_E2E_PASSWORD) or the documented test
 * default, and is never written to disk — the same rule as the mobile fixture.
 * Re-running retires the previous accounts and companies (see `clean`), so a suite always
 * starts from the same state.
 */
import { type BusinessModule } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { hash } from "bcrypt";

import {
  permissionLabels,
  type PermissionKey,
} from "../../src/config/permissions";
import { ensureDefaultOccurrenceTypes } from "../../src/shared/delivery/default-occurrence-types";
import {
  businessDateKey,
  dateOnlyFromKey,
} from "../../src/shared/time/business-day";
import { assertDisposableDatabase } from "./lib/disposable-database";

const prisma = createPrismaClient();

const PASSWORD = process.env.WEB_E2E_PASSWORD ?? "Navegador@E2E2026";

const OUT = process.env.WEB_E2E_USERS_OUT
  ? resolve(process.env.WEB_E2E_USERS_OUT)
  : resolve(__dirname, "fixtures", "browser-users.json");

const TIME_ZONE = "America/Sao_Paulo";

// Fixed CNPJs (valid check digits) so a re-run finds and replaces them.
const COMPANIES = {
  full: {
    cnpj: "11444777000161",
    label: "E2E Completa",
    modules: ["FLEET", "DELIVERIES"],
  },
  fleetOnly: {
    cnpj: "45723174000110",
    label: "E2E Só Frota",
    modules: ["FLEET"],
  },
  deliveriesOnly: {
    cnpj: "60701190000104",
    label: "E2E Só Entregas",
    modules: ["DELIVERIES"],
  },
} as const satisfies Record<
  string,
  { cnpj: string; label: string; modules: BusinessModule[] }
>;

const EMAILS = {
  master: "master.e2e@trajetto.test",
  admin: "admin.e2e@trajetto.test",
  fullUser: "usuario.completo@trajetto.test",
  readOnlyUser: "usuario.leitura@trajetto.test",
  driver: "motorista.web@trajetto.test",
  twoFactor: "dois.fatores@trajetto.test",
  fleetOnlyAdmin: "admin.frota@trajetto.test",
  deliveriesOnlyAdmin: "admin.entregas@trajetto.test",
  // A second admin of the full company: user switch in the same tab and the
  // two-context freshness specs need two people of ONE company.
  secondAdmin: "admin2.e2e@trajetto.test",
} as const;

const ALL_KEYS = Object.keys(permissionLabels) as PermissionKey[];

async function company(spec: (typeof COMPANIES)[keyof typeof COMPANIES]) {
  const businessId = randomUUID();

  await prisma.business.create({
    data: {
      id: businessId,
      corporate_reason: `Transportadora ${spec.label}`,
      fantasy_name: spec.label,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua da Carga",
      address_number: "1",
      cnpj: spec.cnpj,
      cnae: "4930202",
      responsible_name: "Responsável E2E",
      telephone: "11999999999",
      email: `empresa-${randomUUID()}@exemplo.com.br`,
      // Every journey and realtime spec registers its own driver and truck
      // (shared ones got stuck in ROUTE_DRIVER_BUSY), so the browser suites
      // add vehicles on every run; at 20 the third full run answered
      // VEHICLE_LIMIT_REACHED. The limit itself is covered by its own tests.
      vehicle_limit: 5_000,
      timezone: TIME_ZONE,
    },
  });

  await prisma.businessEntitlement.createMany({
    data: spec.modules.map((module) => ({ businessId, module, enabled: true })),
  });

  await ensureDefaultOccurrenceTypes(prisma, businessId);

  return businessId;
}

async function user(data: {
  email: string;
  name: string;
  role: "MASTER" | "BUSINESS_ADMIN" | "BUSINESS_USER";
  passwordHash: string;
  businessId?: string;
  profileAccessId?: string;
  driverId?: string;
  twoFactor?: boolean;
}) {
  const created = await prisma.user.create({
    data: {
      name: data.name,
      email: data.email,
      password: data.passwordHash,
      role: data.role,
      email_verified: new Date(),
      businessId: data.businessId ?? null,
      profileAccessId: data.profileAccessId ?? null,
      driverId: data.driverId ?? null,
      two_factor_enabled: data.twoFactor ?? false,
    },
  });

  if (data.twoFactor) {
    await prisma.twoFactorConfirmation.deleteMany({
      where: { userId: created.id },
    });
  }

  return created.id;
}

async function profile(
  businessId: string,
  name: string,
  grants: { key: PermissionKey; canRead: boolean; canWrite: boolean }[],
) {
  const created = await prisma.profileAccess.create({
    data: { name, businessId },
  });

  await prisma.permission.createMany({
    data: grants.map((grant) => ({
      action: permissionLabels[grant.key],
      permissionKey: grant.key,
      canRead: grant.canRead,
      canWrite: grant.canWrite,
      profileAccessId: created.id,
      businessId,
    })),
  });

  return created.id;
}

/**
 * Retires what a previous run left, so the suite starts from one known state.
 *
 * Retired, not deleted: once a run has worked in these companies, their rows
 * reference each other in ways no single cascade unwinds (an occurrence keeps
 * the user who reported it), and deleting the company failed on a foreign key
 * the second time the script ran. The old companies and accounts keep their
 * history under freed unique keys — a different CNPJ, name and e-mail, the
 * company switched off and the accounts revoked — and nothing can sign in to
 * them again.
 */
async function clean() {
  const stamp = Date.now();

  await prisma.twoFactorToken.deleteMany({
    where: { email: { in: Object.values(EMAILS) } },
  });

  const users = await prisma.user.findMany({
    where: { email: { in: Object.values(EMAILS) } },
    select: { id: true },
  });

  for (const { id } of users) {
    await prisma.user.update({
      where: { id },
      data: {
        email: `retirado-${stamp}-${id}@trajetto.test`,
        access_revoked: true,
        session_version: { increment: 1 },
      },
    });
  }

  const companies = await prisma.business.findMany({
    where: { cnpj: { in: Object.values(COMPANIES).map((spec) => spec.cnpj) } },
    select: { id: true },
  });

  for (const [index, { id }] of companies.entries()) {
    await prisma.business.update({
      where: { id },
      data: {
        // 14 digits, unique per run and company; never a fixture CNPJ.
        cnpj: `9${String(stamp).slice(-11)}${String(index).padStart(2, "0")}`,
        corporate_reason: `Retirada ${stamp}-${index}`,
        email: `retirada-${stamp}-${index}@exemplo.com.br`,
        is_active: false,
      },
    });
  }
}

async function main(): Promise<void> {
  // Browser accounts only ever go into the throwaway database.
  assertDisposableDatabase();

  await clean();

  const passwordHash = await hash(PASSWORD, 10);

  const fullId = await company(COMPANIES.full);
  const fleetOnlyId = await company(COMPANIES.fleetOnly);
  const deliveriesOnlyId = await company(COMPANIES.deliveriesOnly);

  const masterId = await user({
    email: EMAILS.master,
    name: "Suporte Trajetto E2E",
    role: "MASTER",
    passwordHash,
  });

  const adminId = await user({
    email: EMAILS.admin,
    name: "Gestora E2E",
    role: "BUSINESS_ADMIN",
    passwordHash,
    businessId: fullId,
  });

  const secondAdminId = await user({
    email: EMAILS.secondAdmin,
    name: "Segunda Gestora E2E",
    role: "BUSINESS_ADMIN",
    passwordHash,
    businessId: fullId,
  });

  const fullProfile = await profile(
    fullId,
    "Operação completa",
    ALL_KEYS.map((key) => ({ key, canRead: true, canWrite: true })),
  );

  // Read-only on deliveries and nothing else: the person who follows the
  // operation but must not change it.
  const readOnlyProfile = await profile(fullId, "Consulta de entregas", [
    { key: "delivery_manage", canRead: true, canWrite: false },
    { key: "occurrence_manage", canRead: true, canWrite: false },
  ]);

  const fullUserId = await user({
    email: EMAILS.fullUser,
    name: "Operador Completo E2E",
    role: "BUSINESS_USER",
    passwordHash,
    businessId: fullId,
    profileAccessId: fullProfile,
  });

  const readOnlyUserId = await user({
    email: EMAILS.readOnlyUser,
    name: "Consulta E2E",
    role: "BUSINESS_USER",
    passwordHash,
    businessId: fullId,
    profileAccessId: readOnlyProfile,
  });

  const twoFactorId = await user({
    email: EMAILS.twoFactor,
    name: "Gestor Dois Fatores",
    role: "BUSINESS_ADMIN",
    passwordHash,
    businessId: fullId,
    twoFactor: true,
  });

  const driver = await prisma.driver.create({
    data: {
      name: "Motorista Web E2E",
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
      businessId: fullId,
    },
  });

  const fuelType = await prisma.fuelType.create({
    data: { description: "Diesel S10", businessId: fullId },
  });

  const vehicle = await prisma.vehicle.create({
    data: {
      license_plate: "WEB1E23",
      description: "Caminhão do E2E web",
      brand: "Volvo",
      model: "VM",
      acquisition_date: new Date("2020-01-01"),
      fleet_type: "OWNED",
      current_mileage: 50_000,
      maintenance_interval_km: 10_000,
      maintenance_interval_months: 6,
      renavam: randomUUID().replace(/-/g, "").slice(0, 11),
      manufacturing_year: new Date("2019-01-01"),
      model_year: new Date("2020-01-01"),
      km_per_liter: 3,
      number_of_axles: 2,
      status: "ACTIVE",
      businessId: fullId,
      fuelTypeId: fuelType.id,
      driverId: driver.id,
    },
  });

  const driverUserId = await user({
    email: EMAILS.driver,
    name: "Motorista Web E2E",
    role: "BUSINESS_USER",
    passwordHash,
    businessId: fullId,
    driverId: driver.id,
  });

  const shipper = await prisma.shipper.create({
    data: { name: "Embarcador E2E Web", businessId: fullId },
  });

  // A route already released for today, so the driver has something to act
  // on without the journey spec having to build one first.
  const route = await prisma.route.create({
    data: {
      code: 9001,
      name: "Rota E2E Web",
      status: "RELEASED",
      scheduled_date: dateOnlyFromKey(businessDateKey(new Date(), TIME_ZONE)),
      released_at: new Date(),
      businessId: fullId,
      driverId: driver.id,
      vehicleId: vehicle.id,
    },
  });

  const fleetOnlyAdminId = await user({
    email: EMAILS.fleetOnlyAdmin,
    name: "Gestor Só Frota",
    role: "BUSINESS_ADMIN",
    passwordHash,
    businessId: fleetOnlyId,
  });

  const deliveriesOnlyAdminId = await user({
    email: EMAILS.deliveriesOnlyAdmin,
    name: "Gestor Só Entregas",
    role: "BUSINESS_ADMIN",
    passwordHash,
    businessId: deliveriesOnlyId,
  });

  const fixture = {
    companies: {
      full: { id: fullId, ...COMPANIES.full },
      fleetOnly: { id: fleetOnlyId, ...COMPANIES.fleetOnly },
      deliveriesOnly: { id: deliveriesOnlyId, ...COMPANIES.deliveriesOnly },
    },
    users: {
      master: { id: masterId, email: EMAILS.master },
      admin: { id: adminId, email: EMAILS.admin },
      secondAdmin: { id: secondAdminId, email: EMAILS.secondAdmin },
      fullUser: { id: fullUserId, email: EMAILS.fullUser },
      readOnlyUser: { id: readOnlyUserId, email: EMAILS.readOnlyUser },
      twoFactor: { id: twoFactorId, email: EMAILS.twoFactor },
      driver: { id: driverUserId, email: EMAILS.driver, driverId: driver.id },
      fleetOnlyAdmin: { id: fleetOnlyAdminId, email: EMAILS.fleetOnlyAdmin },
      deliveriesOnlyAdmin: {
        id: deliveriesOnlyAdminId,
        email: EMAILS.deliveriesOnlyAdmin,
      },
    },
    full: {
      shipperId: shipper.id,
      vehicleId: vehicle.id,
      driverId: driver.id,
      routeId: route.id,
      fuelTypeId: fuelType.id,
    },
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(fixture, null, 2), "utf8");

  console.log(`[Web E2E] Usuários do navegador escritos em ${OUT}`);

  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);

  await prisma.$disconnect();
  process.exit(1);
});
