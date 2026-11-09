import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { hash } from "bcrypt";

import {
  hashDeviceId,
  issueSessionTokenPair,
} from "@/modules/user/services/session-service";

/**
 * Carriers, drivers and logins for the E2E files of the driver's ways in
 * (plan of 02/11/2026: A3, D2-D8). Each E2E file gets a database of its own,
 * so random ids and documents never collide between files.
 */

let cnpj = 61000000000100 + Math.floor(Math.random() * 1_000_000);

async function seedCarrier(
  prisma: PrismaClient,
  options: { fantasyName?: string | null } = {},
): Promise<string> {
  const id = randomUUID();

  cnpj += 1;

  await prisma.business.create({
    data: {
      id,
      corporate_reason: `Transportadora ${id.slice(0, 8)} LTDA`,
      fantasy_name:
        options.fantasyName === undefined
          ? `Rápido ${id.slice(0, 4)}`
          : options.fantasyName,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(cnpj),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `${id}@exemplo.com.br`,
      vehicle_limit: 10,
    },
  });

  return id;
}

async function seedDriver(
  prisma: PrismaClient,
  businessId: string,
  options: { cpf: string; status?: "ACTIVE" | "INACTIVE" },
): Promise<string> {
  const suffix = randomUUID().replace(/\D/g, "").slice(0, 10).padEnd(10, "7");

  const driver = await prisma.driver.create({
    data: {
      name: "Motorista do Acesso",
      birth_date: new Date("1990-01-01T03:00:00.000Z"),
      cnh: `9${suffix}`,
      cpf: options.cpf,
      rg: "123456789",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      status: options.status ?? "ACTIVE",
      contract_type: "OWNED",
      businessId,
    },
  });

  return driver.id;
}

async function seedLogin(
  prisma: PrismaClient,
  options: {
    businessId: string | null;
    role: "BUSINESS_ADMIN" | "BUSINESS_USER" | "MASTER";
    driverId?: string;
    password?: string;
    email?: string;
  },
): Promise<string> {
  const id = randomUUID();

  await prisma.user.create({
    data: {
      id,
      name: options.driverId ? "Motorista Login" : "Gestora Acesso",
      email: options.email ?? `${id}@exemplo.com.br`,
      password: await hash(options.password ?? "nao-usado-aqui", 4),
      role: options.role,
      businessId: options.businessId,
      driverId: options.driverId ?? null,
      email_verified: new Date(),
    },
  });

  return id;
}

interface SeededSession {
  access: string;
  refresh: string;
  familyId: string;
}

/** A live session of the user, as a login would have opened it. */
async function openSession(
  prisma: PrismaClient,
  userId: string,
): Promise<SeededSession> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const pair = issueSessionTokenPair(user as never);

  await prisma.refreshToken.create({
    data: {
      userId,
      token_hash: pair.refreshTokenHash,
      jti: pair.refreshJti,
      family_id: pair.familyId,
      expires_in: pair.expiresAt,
    },
  });

  return {
    access: pair.token,
    refresh: pair.refresh_token,
    familyId: pair.familyId,
  };
}

/**
 * The phone trusted for the login's CPF sign-in (wave 2), as a QR code read
 * on it would have left it: by the device id's hash only.
 */
async function seedTrustedDevice(
  prisma: PrismaClient,
  userId: string,
  deviceId: string,
  source: "qr" | "backfill" = "qr",
): Promise<void> {
  await prisma.driverTrustedDevice.create({
    data: { userId, device_hash: hashDeviceId(deviceId), source },
  });
}

let next = 1;

/**
 * A fresh address per request, for the files that are not about the route
 * limits: the per-address counters live in Redis across runs.
 */
function freshAddress(prefix = "10.81"): string {
  const value = next++;

  return `${prefix}.${Math.floor(value / 250) % 250}.${(value % 250) + 1}`;
}

export {
  freshAddress,
  openSession,
  seedCarrier,
  seedDriver,
  seedLogin,
  seedTrustedDevice,
  type SeededSession,
};
