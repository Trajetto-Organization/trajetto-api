import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { sign } from "jsonwebtoken";

import auth from "@/config/auth";

/**
 * Carriers, people and fleet rows for the maintenance E2E files (service
 * orders, their parts, the parts catalog). Each E2E file gets a database of
 * its own, so fixed ids never collide between files.
 */

let cnpjSeq = 0;

async function seedCarrier(
  prisma: PrismaClient,
  id: string,
  modules: Array<"FLEET" | "DELIVERIES"> = ["FLEET", "DELIVERIES"],
): Promise<void> {
  cnpjSeq += 1;

  await prisma.business.create({
    data: {
      id,
      corporate_reason: `Transportadora ${id.slice(-4)}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(51222333000100 + cnpjSeq),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `${id}@exemplo.com.br`,
      vehicle_limit: 50,
    },
  });

  if (modules.length > 0) {
    await prisma.businessEntitlement.createMany({
      data: modules.map((module) => ({
        businessId: id,
        module,
        enabled: true,
      })),
    });
  }
}

/** A profile with the given keys (read, write). */
async function seedProfile(
  prisma: PrismaClient,
  businessId: string,
  grants: Array<{ key: string; write: boolean }>,
): Promise<string> {
  const profile = await prisma.profileAccess.create({
    data: {
      name: `Perfil ${randomUUID().slice(0, 8)}`,
      businessId,
      permissions: {
        create: grants.map(({ key, write }) => ({
          permissionKey: key,
          action: key,
          canRead: true,
          canWrite: write,
          businessId,
        })),
      },
    },
  });

  return profile.id;
}

async function seedUser(
  prisma: PrismaClient,
  name: string,
  role: "MASTER" | "BUSINESS_ADMIN" | "BUSINESS_USER",
  businessId: string | null,
  extra: { profileAccessId?: string; driverId?: string } = {},
): Promise<{ id: string; token: string }> {
  const id = randomUUID();
  const familyId = randomUUID();

  await prisma.user.create({
    data: {
      id,
      name,
      email: `${id}@exemplo.com.br`,
      password: "not-used-here",
      role,
      businessId,
      profileAccessId: extra.profileAccessId ?? null,
      driverId: extra.driverId ?? null,
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

  return {
    id,
    token: sign(
      { tokenType: "access", sessionVersion: 0, familyId },
      auth.secret_token,
      { subject: id, expiresIn: "30m" },
    ),
  };
}

async function seedBranch(
  prisma: PrismaClient,
  businessId: string,
  name: string,
): Promise<string> {
  cnpjSeq += 1;

  const branch = await prisma.branch.create({
    data: {
      corporate_reason: name,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(61222333000100 + cnpjSeq),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `filial-${randomUUID()}@exemplo.com.br`,
      businessId,
    },
  });

  return branch.id;
}

async function seedDriver(
  prisma: PrismaClient,
  businessId: string,
): Promise<string> {
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
    },
  });

  return driver.id;
}

async function seedVehicle(
  prisma: PrismaClient,
  businessId: string,
  options: {
    plate: string;
    branchId?: string;
    mileage?: number;
    driverId?: string;
  },
): Promise<string> {
  const fuelType = await prisma.fuelType.create({
    data: { description: `Diesel ${randomUUID().slice(0, 6)}`, businessId },
  });

  const vehicle = await prisma.vehicle.create({
    data: {
      license_plate: options.plate,
      description: `Caminhão ${options.plate}`,
      brand: "Marca",
      model: "Modelo",
      acquisition_date: new Date("2020-01-01"),
      fleet_type: "OWNED",
      current_mileage: options.mileage ?? 10_000,
      maintenance_interval_km: 10_000,
      maintenance_interval_months: 6,
      renavam: randomUUID().slice(0, 11),
      manufacturing_year: new Date("2019-01-01"),
      model_year: new Date("2020-01-01"),
      km_per_liter: 3,
      number_of_axles: 2,
      status: "ACTIVE",
      businessId,
      branchId: options.branchId ?? null,
      fuelTypeId: fuelType.id,
      driverId: options.driverId ?? null,
    },
  });

  return vehicle.id;
}

async function seedSupplier(
  prisma: PrismaClient,
  businessId: string,
  name: string,
): Promise<string> {
  cnpjSeq += 1;

  const supplier = await prisma.supplier.create({
    data: { name, cnpj: String(71222333000100 + cnpjSeq), businessId },
  });

  return supplier.id;
}

/** An NDJSON listing as the web reads it: the meta line, then the rows. */
async function readNdjson<
  TRow = Record<string, unknown>,
  TMeta = Record<string, unknown>,
>(
  app: {
    inject: (options: object) => Promise<{ statusCode: number; body: string }>;
  },
  url: string,
  token: string,
): Promise<{ status: number; meta: TMeta; rows: TRow[]; body: string }> {
  const response = await app.inject({
    method: "GET",
    url,
    headers: { authorization: `Bearer ${token}` },
  });

  if (response.statusCode !== 200) {
    return {
      status: response.statusCode,
      meta: {} as TMeta,
      rows: [],
      body: response.body,
    };
  }

  const [first, ...rest] = response.body
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  return { status: 200, meta: first.meta, rows: rest, body: response.body };
}

export {
  readNdjson,
  seedBranch,
  seedCarrier,
  seedDriver,
  seedProfile,
  seedSupplier,
  seedUser,
  seedVehicle,
};
