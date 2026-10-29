import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { sign } from "jsonwebtoken";
import { randomUUID } from "node:crypto";

import auth from "@/config/auth";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * The company's plan as the "Limites de Uso" card reads it, over HTTP and
 * Postgres.
 *
 * The card showed two numbers (slots in use and contracted) and called the
 * first "Veículos ativos", while it counts every vehicle but the INACTIVE
 * ones — the Vehicles page calls only ACTIVE "Ativos". The route now answers
 * the fleet by status, from one grouped count; the serializer strips any key
 * the response schema does not declare, so only a real request proves the
 * breakdown reaches the browser.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018fef00-0000-7000-8000-00000000000a";
const OTHER = "018fef00-0000-7000-8000-00000000000b";

const tokens: Record<"admin" | "otherAdmin" | "clerk" | "master", string> =
  {} as never;

async function session(
  businessId: string | null,
  role: "MASTER" | "BUSINESS_ADMIN" | "BUSINESS_USER",
): Promise<string> {
  const id = randomUUID();
  const familyId = randomUUID();

  // A business user with a working profile, so the refusal is the route's
  // role gate and not a session without permissions.
  const profileAccessId =
    role === "BUSINESS_USER" && businessId
      ? (
          await prisma.profileAccess.create({
            data: {
              name: `Perfil ${id.slice(0, 8)}`,
              businessId,
              permissions: {
                create: [
                  {
                    permissionKey: "vehicle_manage",
                    action: "vehicle_manage",
                    canRead: true,
                    canWrite: true,
                    businessId,
                  },
                ],
              },
            },
          })
        ).id
      : null;

  await prisma.user.create({
    data: {
      id,
      name: "Gestora",
      email: `${id}@exemplo.com.br`,
      password: "not-used-here",
      role,
      businessId,
      profileAccessId,
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

  return sign(
    { tokenType: "access", sessionVersion: 0, familyId },
    auth.secret_token,
    { subject: id, expiresIn: "15m" },
  );
}

async function seedBusiness(id: string, cnpj: string, vehicleLimit: number) {
  await prisma.business.create({
    data: {
      id,
      corporate_reason: `Transportadora ${id.slice(-1)}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj,
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `${id}@exemplo.com.br`,
      vehicle_limit: vehicleLimit,
    },
  });

  await prisma.businessEntitlement.create({
    data: { businessId: id, module: "FLEET", enabled: true },
  });
}

async function seedFleet(
  businessId: string,
  statuses: Array<"ACTIVE" | "INACTIVE" | "BLOCKED" | "IN_ROUTE">,
) {
  const fuelType = await prisma.fuelType.create({
    data: { description: "Diesel", businessId },
  });

  await prisma.vehicle.createMany({
    data: statuses.map((status, index) => ({
      description: `Caminhão ${index}`,
      license_plate: `ENT${businessId.slice(-1).toUpperCase()}${1000 + index}`,
      brand: "Volvo",
      model: "FH",
      acquisition_date: new Date("2024-01-10T12:00:00.000Z"),
      fleet_type: "OWNED" as const,
      renavam: `renavam-ent-${randomUUID()}`,
      manufacturing_year: new Date("2024-01-01T12:00:00.000Z"),
      model_year: new Date("2024-01-01T12:00:00.000Z"),
      current_mileage: 1000,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      km_per_liter: 3,
      number_of_axles: 3,
      status,
      businessId,
      fuelTypeId: fuelType.id,
    })),
  });
}

beforeAll(async () => {
  // A contract of 6 with 6 vehicles occupying slots: the card's "full" case.
  await seedBusiness(CARRIER, "62888888000190", 6);
  await seedBusiness(OTHER, "62888888000271", 3);

  await seedFleet(CARRIER, [
    "ACTIVE",
    "ACTIVE",
    "ACTIVE",
    "BLOCKED",
    "BLOCKED",
    "IN_ROUTE",
    "INACTIVE",
    "INACTIVE",
  ]);

  // Another company's fleet, which must never leak into the carrier's.
  await seedFleet(OTHER, ["ACTIVE", "INACTIVE", "INACTIVE", "INACTIVE"]);

  tokens.admin = await session(CARRIER, "BUSINESS_ADMIN");
  tokens.otherAdmin = await session(OTHER, "BUSINESS_ADMIN");
  tokens.clerk = await session(CARRIER, "BUSINESS_USER");
  tokens.master = await session(null, "MASTER");

  ({ app } = await import("@/http"));
  await app.ready();
}, 90_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

const read = (businessId: string, token: string) =>
  app.inject({
    method: "GET",
    url: `/business/entitlements/${businessId}`,
    headers: { authorization: `Bearer ${token}` },
  });

describe("GET /business/entitlements", () => {
  it("answers the admin's own fleet by status, with the slot count it adds up to", async () => {
    const response = await read(CARRIER, tokens.admin);

    expect(response.statusCode, response.body).toBe(200);

    const data = response.json().data;

    // Every status but INACTIVE occupies a slot: 3 + 2 + 1.
    expect(data).toMatchObject({
      vehicle_limit: 6,
      vehicle_count: 6,
      vehicle_inactive_count: 2,
      vehicle_limit_enabled: true,
      modules: [{ module: "FLEET", enabled: true }],
    });

    // Red before: the response schema had no such key, so even a use case
    // that computed it would have had it stripped on the way out.
    expect(data.vehicle_status_counts).toEqual({
      ACTIVE: 3,
      BLOCKED: 2,
      IN_ROUTE: 1,
      INACTIVE: 2,
    });
  });

  it("lets the MASTER read any company's plan, each with its own fleet", async () => {
    const carrier = await read(CARRIER, tokens.master);
    const other = await read(OTHER, tokens.master);

    expect(carrier.statusCode, carrier.body).toBe(200);
    expect(other.statusCode, other.body).toBe(200);

    expect(other.json().data).toMatchObject({
      vehicle_limit: 3,
      vehicle_count: 1,
      vehicle_inactive_count: 3,
      vehicle_status_counts: {
        ACTIVE: 1,
        BLOCKED: 0,
        IN_ROUTE: 0,
        INACTIVE: 3,
      },
    });
    expect(carrier.json().data.vehicle_status_counts.ACTIVE).toBe(3);
  });

  it("does not show one company's fleet to another's admin", async () => {
    const response = await read(CARRIER, tokens.otherAdmin);

    expect(response.statusCode, response.body).toBe(403);
    expect(response.json().code).toBe("TENANT_ACCESS_DENIED");
    expect(response.body).not.toContain("vehicle_status_counts");
  });

  it("refuses a plain user of the company, even one who manages vehicles", async () => {
    const response = await read(CARRIER, tokens.clerk);

    expect(response.statusCode, response.body).toBe(403);
    expect(response.json().code).toBe("AUTH_ROLE_FORBIDDEN");
  });

  it("answers a company that does not exist with 404 and its code", async () => {
    const response = await read(randomUUID(), tokens.master);

    expect(response.statusCode, response.body).toBe(404);
    expect(response.json().code).toBe("BUSINESS_NOT_FOUND");
  });
});
