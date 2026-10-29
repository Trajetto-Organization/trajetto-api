import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import { sign } from "jsonwebtoken";

import auth from "@/config/auth";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * A record belongs to the company it was created in (decision 16.100): no
 * update moves it to another company, not even the MASTER's.
 *
 * The user edit used to accept a body `businessId` from a MASTER and moved
 * the person; the other edits stripped the field silently and answered 200.
 * Now every update body refuses it with 400 VALIDATION_ERROR — the route
 * schema runs before the tenant guard, so the answer is the same for a
 * MASTER and for a company administrator — and the row stays where it was.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const A = randomUUID();
const B = randomUUID();

const HASH = "$2a$08$hash.da.senha.atual.que.nao.pode.mudar.aqui...........";

let cnpj = 52000000000100;

async function seedBusiness(id: string): Promise<void> {
  cnpj += 1;

  await prisma.business.create({
    data: {
      id,
      corporate_reason: `Transportadora ${id.slice(0, 4)}`,
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

  await prisma.businessEntitlement.create({
    data: { businessId: id, module: "FLEET", enabled: true },
  });
}

interface Seeded {
  id: string;
  token: string;
}

async function seedUser(data: {
  role: "MASTER" | "BUSINESS_ADMIN" | "BUSINESS_USER";
  businessId: string | null;
  profileAccessId?: string | null;
}): Promise<Seeded> {
  const id = randomUUID();
  const familyId = randomUUID();

  await prisma.user.create({
    data: {
      id,
      name: "Pessoa Cadastrada",
      email: `${id}@exemplo.com.br`,
      password: HASH,
      role: data.role,
      businessId: data.businessId,
      profileAccessId: data.profileAccessId ?? null,
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

async function seedProfile(businessId: string): Promise<string> {
  const profile = await prisma.profileAccess.create({
    data: { name: `Operação ${randomUUID().slice(0, 6)}`, businessId },
  });

  await prisma.permission.create({
    data: {
      action: "kanban_manage",
      permissionKey: "kanban_manage",
      canRead: true,
      canWrite: false,
      businessId,
      profileAccessId: profile.id,
    },
  });

  return profile.id;
}

async function seedDriver(businessId: string): Promise<string> {
  const suffix = randomUUID().replace(/\D/g, "").slice(0, 9).padEnd(9, "0");

  const driver = await prisma.driver.create({
    data: {
      name: "Motorista Cadastrado",
      birth_date: new Date("1990-01-01T03:00:00.000Z"),
      cnh: `9${suffix}0`,
      cpf: `8${suffix}0`,
      rg: "123456789",
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

async function seedVehicle(businessId: string): Promise<string> {
  const plate = `MOV${randomUUID().replace(/\D/g, "").slice(0, 4).padEnd(4, "0")}`;

  const fuelType = await prisma.fuelType.create({
    data: { description: `Diesel ${plate}`, businessId },
  });

  const vehicle = await prisma.vehicle.create({
    data: {
      description: `Caminhão ${plate}`,
      license_plate: plate,
      brand: "Scania",
      model: "R450",
      acquisition_date: new Date(),
      fleet_type: "OWNED",
      current_mileage: 0,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: `rnv-${randomUUID().slice(0, 10)}`,
      manufacturing_year: new Date(),
      model_year: new Date(),
      km_per_liter: 3,
      number_of_axles: 3,
      status: "ACTIVE",
      businessId,
      fuelTypeId: fuelType.id,
    },
  });

  return vehicle.id;
}

async function patch(
  actor: Seeded,
  url: string,
  payload: Record<string, unknown>,
) {
  return app.inject({
    method: "PATCH",
    url,
    headers: { authorization: `Bearer ${actor.token}` },
    payload,
  });
}

function expectValidationRefusal(response: {
  statusCode: number;
  body: string;
}) {
  expect(response.statusCode, response.body).toBe(400);

  const body = JSON.parse(response.body);

  expect(body.code).toBe("VALIDATION_ERROR");
  expect(body.issues.join(" ")).toContain(
    "A empresa de um registro não muda pela edição",
  );
}

let admin: Seeded;
let master: Seeded;
let profileA = "";
let profileB = "";

beforeAll(async () => {
  await seedBusiness(A);
  await seedBusiness(B);

  profileA = await seedProfile(A);
  profileB = await seedProfile(B);

  admin = await seedUser({ role: "BUSINESS_ADMIN", businessId: A });
  master = await seedUser({ role: "MASTER", businessId: null });

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await prisma.business.deleteMany({ where: { id: { in: [A, B] } } });
  await prisma.user.deleteMany({ where: { id: master.id } });
  await prisma.$disconnect();
});

describe("moving a user to another company", () => {
  it("is refused for the MASTER, and the user stays in their company", async () => {
    const target = await seedUser({
      role: "BUSINESS_USER",
      businessId: A,
      profileAccessId: profileA,
    });

    const response = await patch(master, `/user/update-user/${target.id}`, {
      role: "BUSINESS_USER",
      businessId: B,
      profileAccessId: profileB,
    });

    expectValidationRefusal(response);

    const after = await prisma.user.findUniqueOrThrow({
      where: { id: target.id },
    });

    expect(after.businessId).toBe(A);
    expect(after.profileAccessId).toBe(profileA);
    // Not even the session was touched.
    expect(after.session_version).toBe(0);
  });

  it("is refused for a company administrator", async () => {
    const target = await seedUser({
      role: "BUSINESS_USER",
      businessId: A,
      profileAccessId: profileA,
    });

    const response = await patch(admin, `/user/update-user/${target.id}`, {
      businessId: B,
      profileAccessId: profileB,
    });

    expectValidationRefusal(response);
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: target.id } }))
        .businessId,
    ).toBe(A);
  });

  it("refuses the field even when it names the user's own company", async () => {
    const target = await seedUser({
      role: "BUSINESS_USER",
      businessId: A,
      profileAccessId: profileA,
    });

    const response = await patch(master, `/user/update-user/${target.id}`, {
      name: "Nome Novo Completo",
      businessId: A,
    });

    expectValidationRefusal(response);
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: target.id } })).name,
    ).toBe("Pessoa Cadastrada");
  });

  it("still edits the user when the body does not name a company", async () => {
    const target = await seedUser({
      role: "BUSINESS_USER",
      businessId: A,
      profileAccessId: profileA,
    });

    const response = await patch(master, `/user/update-user/${target.id}`, {
      name: "Nome Novo Completo",
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(
      await prisma.user.findUniqueOrThrow({ where: { id: target.id } }),
    ).toMatchObject({
      name: "Nome Novo Completo",
      businessId: A,
    });
  });
});

describe("moving a driver to another company", () => {
  it.each([
    ["MASTER", () => master],
    ["BUSINESS_ADMIN", () => admin],
  ])("is refused for the %s", async (_role, actor) => {
    const driverId = await seedDriver(A);

    const response = await patch(
      actor(),
      `/driver/update-driver/${driverId}/business/${A}`,
      {
        name: "Motorista Renomeado",
        businessId: B,
      },
    );

    expectValidationRefusal(response);
    expect(
      await prisma.driver.findUniqueOrThrow({ where: { id: driverId } }),
    ).toMatchObject({
      name: "Motorista Cadastrado",
      businessId: A,
    });
  });
});

describe("moving a vehicle to another company", () => {
  it.each([
    ["MASTER", () => master],
    ["BUSINESS_ADMIN", () => admin],
  ])("is refused for the %s", async (_role, actor) => {
    const vehicleId = await seedVehicle(A);

    const response = await patch(
      actor(),
      `/vehicle/update-vehicle/${vehicleId}/business/${A}`,
      {
        brand: "Volvo",
        businessId: B,
      },
    );

    expectValidationRefusal(response);
    expect(
      await prisma.vehicle.findUniqueOrThrow({ where: { id: vehicleId } }),
    ).toMatchObject({
      brand: "Scania",
      businessId: A,
    });
  });
});

describe("moving a permission or a profile to another company", () => {
  it("refuses a MASTER re-homing a permission onto another company's profile", async () => {
    const permission = await prisma.permission.findFirstOrThrow({
      where: { profileAccessId: profileA },
    });

    const response = await patch(
      master,
      `/permission/update-permission/${permission.id}`,
      {
        action: "kanban_manage",
        canRead: true,
        businessId: B,
        profileAccessId: profileB,
      },
    );

    expectValidationRefusal(response);
    expect(
      await prisma.permission.findUniqueOrThrow({
        where: { id: permission.id },
      }),
    ).toMatchObject({
      businessId: A,
      profileAccessId: profileA,
    });
  });

  it("refuses another company's profile even without a businessId in the body", async () => {
    const permission = await prisma.permission.findFirstOrThrow({
      where: { profileAccessId: profileA },
    });

    const response = await patch(
      master,
      `/permission/update-permission/${permission.id}`,
      {
        action: "kanban_manage",
        canRead: true,
        profileAccessId: profileB,
      },
    );

    expect(response.statusCode, response.body).toBe(400);
    expect(JSON.parse(response.body).code).toBe("PROFILE_ACCESS_NOT_FOUND");
    expect(
      (
        await prisma.permission.findUniqueOrThrow({
          where: { id: permission.id },
        })
      ).businessId,
    ).toBe(A);
  });

  it("edits a permission with no businessId in the body, in its own company", async () => {
    const permission = await prisma.permission.findFirstOrThrow({
      where: { profileAccessId: profileA },
    });

    const response = await patch(
      master,
      `/permission/update-permission/${permission.id}`,
      {
        action: "kanban_manage",
        canRead: true,
        canWrite: true,
        profileAccessId: profileA,
      },
    );

    expect(response.statusCode, response.body).toBe(200);
    expect(
      await prisma.permission.findUniqueOrThrow({
        where: { id: permission.id },
      }),
    ).toMatchObject({
      businessId: A,
      canWrite: true,
    });
  });

  it("refuses a businessId on the profile edit", async () => {
    const response = await patch(
      master,
      `/profile-access/update-profile-access/${profileA}`,
      {
        name: "Perfil Renomeado",
        businessId: B,
      },
    );

    expectValidationRefusal(response);
    expect(
      (
        await prisma.profileAccess.findUniqueOrThrow({
          where: { id: profileA },
        })
      ).businessId,
    ).toBe(A);
  });
});
