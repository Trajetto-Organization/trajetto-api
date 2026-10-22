import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { sign } from "jsonwebtoken";

import auth from "@/config/auth";

/**
 * One carrier with one driver who can refuel, inspect and deliver.
 *
 * Shared by the tests that post what the app's outbox posts — fuelings,
 * checklists, arrivals, proofs, occurrences — over real HTTP, against a real
 * database. Each E2E file gets a database of its own, so the fixed ids never
 * collide between files.
 */
interface FleetDriverSeed {
  businessId: string;
  branchId: string;
  driverId: string;
  vehicleId: string;
  fuelTypeId: string;
  driverUserId: string;
  driverToken: string;
  managerToken: string;
}

async function seedUser(
  prisma: PrismaClient,
  businessId: string,
  role: "BUSINESS_ADMIN" | "BUSINESS_USER",
  driverId?: string,
): Promise<{ id: string; token: string }> {
  const id = randomUUID();
  const familyId = randomUUID();

  await prisma.user.create({
    data: {
      id,
      name: role === "BUSINESS_USER" ? "Motorista" : "Gestora",
      email: `${id}@exemplo.com.br`,
      password: "not-used-here",
      role,
      businessId,
      driverId: driverId ?? null,
    },
  });

  await prisma.refreshToken.create({
    data: {
      userId: id,
      token_hash: randomUUID(),
      jti: randomUUID(),
      family_id: familyId,
      expires_in: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

  const token = sign(
    { tokenType: "access", sessionVersion: 0, familyId },
    auth.secret_token,
    { subject: id, expiresIn: "30m" },
  );

  return { id, token };
}

async function seedFleetDriver(
  prisma: PrismaClient,
  options: { businessId: string; cnpj: string; mileage?: number },
): Promise<FleetDriverSeed> {
  const { businessId, cnpj } = options;

  await prisma.business.create({
    data: {
      id: businessId,
      corporate_reason: `Transportadora ${businessId.slice(-4)}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj,
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `carrier-${randomUUID()}@exemplo.com.br`,
      vehicle_limit: 10,
    },
  });

  await prisma.businessEntitlement.createMany({
    data: [
      { businessId, module: "FLEET", enabled: true },
      { businessId, module: "DELIVERIES", enabled: true },
    ],
  });

  const branch = await prisma.branch.create({
    data: {
      corporate_reason: `Filial ${randomUUID().slice(0, 6)}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: `${cnpj.slice(0, 8)}0002${cnpj.slice(-2)}`,
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `filial-${randomUUID()}@exemplo.com.br`,
      businessId,
    },
  });

  const driver = await prisma.driver.create({
    data: {
      name: "Motorista da Frota",
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
    data: {
      description: `Tipo ${randomUUID().slice(0, 6)}`,
      number_of_axles: 2,
      businessId,
    },
  });

  const fuelType = await prisma.fuelType.create({
    data: {
      description: `Diesel ${randomUUID().slice(0, 6)}`,
      businessId,
    },
  });

  const vehicle = await prisma.vehicle.create({
    data: {
      license_plate: randomUUID().slice(0, 7).toUpperCase(),
      description: "Caminhão da Frota",
      brand: "Marca",
      model: "Modelo",
      acquisition_date: new Date("2020-01-01"),
      fleet_type: "OWNED",
      current_mileage: options.mileage ?? 1_000,
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

  const driverUser = await seedUser(
    prisma,
    businessId,
    "BUSINESS_USER",
    driver.id,
  );
  const manager = await seedUser(prisma, businessId, "BUSINESS_ADMIN");

  return {
    businessId,
    branchId: branch.id,
    driverId: driver.id,
    vehicleId: vehicle.id,
    fuelTypeId: fuelType.id,
    driverUserId: driverUser.id,
    driverToken: driverUser.token,
    managerToken: manager.token,
  };
}

/**
 * The smallest file every image check accepts: a JPEG's first bytes, then
 * padding. Nothing here decodes the picture — storage and the API only look
 * at the signature and the size.
 */
function fakeJpeg(size = 2_048): Buffer {
  const bytes = Buffer.alloc(size, 0x20);

  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  bytes[2] = 0xff;
  bytes[3] = 0xe0;

  return bytes;
}

export { fakeJpeg, seedFleetDriver, seedUser };
export type { FleetDriverSeed };
