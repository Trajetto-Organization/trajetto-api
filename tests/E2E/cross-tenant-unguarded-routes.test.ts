import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import { sign } from "jsonwebtoken";
import auth from "@/config/auth";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * The routes where nothing in the URL names a tenant.
 *
 * A sweep of every route that takes a record id turned up 79 of them. Most
 * carry `/business/:businessId`, so the tenant middleware has something to
 * compare the token against before the handler runs. Twenty-two do not: the
 * only thing standing between one carrier and another's row is whatever the
 * use case remembers to check.
 *
 * That is exactly the shape the earlier adversarial audit found six holes in,
 * and every one of those had no test. This file covers the eleven of the
 * twenty-two where a leak actually costs something and the fixture is cheap:
 * users, profiles and their permissions, a driver's GPS trail, another
 * carrier's fuel and maintenance history, and somebody else's notifications.
 *
 * The premise, as before: knowing an id is not an exploit. Ids travel in
 * exports, screenshots and support tickets. What has to hold is that knowing
 * is not enough.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const A = "018fb000-0000-7000-8000-00000000000a";
const B = "018fb000-0000-7000-8000-00000000000b";

let tokenA = "";

/** Company A's own profile, so the attacker can send ids that are really theirs. */
let profileA = "";

/** Everything company B owns, which company A must never reach. */
const B_OWNED = {
  userId: "",

  /**
   * A second user of B's, with nothing hanging off them.
   *
   * The delete test needs a target that only the tenant rule protects. The
   * first victim is the responsible party on B's service order, and deleting a
   * user with associated service orders is refused by a DIFFERENT guard — so
   * that test passed with the tenant check commented out, which a mutation
   * caught and a green suite would not have.
   */
  deletableUserId: "",
  profileAccessId: "",
  permissionId: "",
  driverId: "",
  vehicleId: "",
  fuelId: "",
  serviceOrderId: "",
  notificationId: "",
};

let cnpjSeq = 0;

async function seedCarrier(id: string): Promise<void> {
  cnpjSeq += 1;

  await prisma.business.create({
    data: {
      id,
      corporate_reason: `Transportadora ${id.slice(-1)}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(33222444000180 + cnpjSeq),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `${id}@exemplo.com.br`,
      vehicle_limit: 10,
    },
  });

  for (const module of ["FLEET", "DELIVERIES"] as const) {
    await prisma.businessEntitlement.create({
      data: { businessId: id, module, enabled: true },
    });
  }
}

async function seedAdmin(businessId: string): Promise<string> {
  const id = randomUUID();
  const familyId = randomUUID();

  await prisma.user.create({
    data: {
      id,
      name: "Gestora",
      email: `${id}@exemplo.com.br`,
      password: "not-used-here",
      role: "BUSINESS_ADMIN",
      businessId,
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
    { subject: id, expiresIn: "30m" },
  );
}

beforeAll(async () => {
  await seedCarrier(A);
  await seedCarrier(B);

  tokenA = await seedAdmin(A);

  profileA = (
    await prisma.profileAccess.create({
      data: { name: "Perfil da A", businessId: A },
    })
  ).id;

  // ---------------------------------------------------- what B owns
  const profile = await prisma.profileAccess.create({
    data: {
      name: "Perfil da B",
      businessId: B,
      permissions: {
        create: [
          {
            permissionKey: "fleet_manage",
            action: "Gerenciar frota",
            canRead: true,
            canWrite: true,
            businessId: B,
          },
        ],
      },
    },
    include: { permissions: true },
  });

  B_OWNED.profileAccessId = profile.id;
  B_OWNED.permissionId = profile.permissions[0].id;

  const victim = await prisma.user.create({
    data: {
      name: "Usuária da B",
      email: `vitima-${randomUUID()}@exemplo.com.br`,
      password: "not-used-here",
      role: "BUSINESS_USER",
      businessId: B,
      profileAccessId: profile.id,
    },
  });

  B_OWNED.userId = victim.id;

  B_OWNED.deletableUserId = (
    await prisma.user.create({
      data: {
        name: "Usuária Solta da B",
        email: `solta-${randomUUID()}@exemplo.com.br`,
        password: "not-used-here",
        role: "BUSINESS_USER",
        businessId: B,
        profileAccessId: profile.id,
      },
    })
  ).id;

  const driver = await prisma.driver.create({
    data: {
      name: "Motorista da B",
      birth_date: new Date("1990-01-01"),
      cnh: `${randomUUID().slice(0, 11)}`,
      cpf: `cpf-${randomUUID()}`,
      rg: `rg-${randomUUID()}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId: B,
    },
  });

  B_OWNED.driverId = driver.id;

  const branch = await prisma.branch.create({
    data: {
      corporate_reason: `Filial da B ${randomUUID().slice(0, 6)}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(44222444000180 + cnpjSeq),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `filial-${randomUUID()}@exemplo.com.br`,
      businessId: B,
    },
  });

  const vehicleType = await prisma.vehicleType.create({
    data: {
      description: `Tipo ${randomUUID().slice(0, 6)}`,
      number_of_axles: 2,
      businessId: B,
    },
  });

  const fuelType = await prisma.fuelType.create({
    data: {
      description: `Combustível ${randomUUID().slice(0, 6)}`,
      businessId: B,
    },
  });

  const vehicle = await prisma.vehicle.create({
    data: {
      license_plate: randomUUID().slice(0, 7).toUpperCase(),
      description: "Caminhão da B",
      brand: "Marca",
      model: "Modelo",
      acquisition_date: new Date("2020-01-01"),
      fleet_type: "OWNED",
      current_mileage: 10_000,
      maintenance_interval_km: 10_000,
      maintenance_interval_months: 6,
      renavam: randomUUID().slice(0, 11),
      manufacturing_year: new Date("2019-01-01"),
      model_year: new Date("2020-01-01"),
      km_per_liter: 3,
      number_of_axles: 2,
      status: "ACTIVE",
      businessId: B,
      branchId: branch.id,
      vehicleTypeId: vehicleType.id,
      fuelTypeId: fuelType.id,
    },
  });

  B_OWNED.vehicleId = vehicle.id;

  const fuel = await prisma.fuel.create({
    data: {
      current_mileage: 10_500,
      liters_amount: 120,
      price_per_liter: 6,
      total_amount: 720,
      odometer_photo: "fuelOdometer/b/foto.webp",
      businessId: B,
      branchId: branch.id,
      vehicleId: vehicle.id,
      fuelTypeId: fuelType.id,
      driverId: driver.id,
    },
  });

  B_OWNED.fuelId = fuel.id;

  const serviceOrder = await prisma.serviceOrder.create({
    data: {
      description: "Revisão da B",
      maintenance_type: "INTERNAL",
      total_amount: 1_234,
      businessId: B,
      branchId: branch.id,
      vehicleId: vehicle.id,
      responsibleUserId: victim.id,
    },
  });

  B_OWNED.serviceOrderId = serviceOrder.id;

  const notification = await prisma.notification.create({
    data: {
      title: "Aviso da B",
      message: "Conteúdo que só a B pode ler",
      type: "Sistema",
      userId: victim.id,
    },
  });

  B_OWNED.notificationId = notification.id;

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

/**
 * Refused by the RULE, and not by anything upstream of it.
 *
 * The first version of the earlier adversarial file passed with every fix
 * reverted, because the payloads were invalid and zod refused first: nine
 * green tests proving that form validation works. A 422 is therefore a
 * FAILURE here — it means the request never reached the check under test.
 *
 * So is a 403 from the entitlement gate, for the same reason, and so is a 500.
 */
async function expectRefused(
  response: { statusCode: number; body: string },
  what: string,
): Promise<void> {
  /**
   * A refusal, not merely "not 200".
   *
   * A successful DELETE answers 204, which `not.toBe(200)` waves through — the
   * exact shape of a test that reports green while the row is gone. The
   * refusal has to be a 4xx.
   */
  expect(
    response.statusCode,
    `${what}: PASSOU — ${response.body.slice(0, 200)}`,
  ).toBeGreaterThanOrEqual(400);

  expect(
    response.statusCode,
    `${what}: recusado pelo schema, não pela regra — ${response.body.slice(0, 200)}`,
  ).not.toBe(422);

  expect(
    response.body.includes('"code":"VALIDATION_ERROR"'),
    `${what}: recusado pelo schema, não pela regra`,
  ).toBe(false);

  expect(
    response.body.includes("MODULE_NOT_ENABLED"),
    `${what}: recusado pelo entitlement, não pela regra de tenant`,
  ).toBe(false);

  expect(
    response.statusCode,
    `${what}: estourou em vez de recusar — ${response.body.slice(0, 200)}`,
  ).toBeLessThan(500);
}

const asA = () => ({ authorization: `Bearer ${tokenA}` });

describe("reading another carrier's people", () => {
  it("does not hand over the users of another company's profile", async () => {
    const response = await app.inject({
      method: "GET",
      /**
       * The attacker's OWN company id, with the victim's profile id.
       *
       * That combination is the attack: sending B's `businessId` is refused by
       * the tenant middleware before anything reads a row, so it proves
       * nothing. Sending A's passes that check, and what is left is whether
       * the query is scoped to the profile's company as well as the caller's.
       */
      url: `/permission/list-by-profile/${B_OWNED.profileAccessId}?businessId=${A}`,
      headers: asA(),
    });

    // A list is the softest possible leak and the easiest to miss: nothing
    // errors, the screen just fills with somebody else's permissions.
    if (response.statusCode === 200) {
      const body = response.json();
      const rows = body.data ?? body;

      expect(
        Array.isArray(rows) ? rows.length : 0,
        `veio ${JSON.stringify(rows).slice(0, 200)}`,
      ).toBe(0);

      return;
    }

    await expectRefused(response, "permissões de outro perfil");
  });
});

describe("writing to another carrier's people", () => {
  it("does not rename another company's user", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: `/user/update-user/${B_OWNED.userId}`,
      headers: asA(),

      // A full name, so zod is satisfied — leaving only the rule under test.
      // (A businessId in the body is refused by the schema, decision 16.100.)
      payload: { name: "Usuária Sequestrada" },
    });

    await expectRefused(response, "renomear usuária da B");

    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: B_OWNED.userId } }))
        .name,
    ).toBe("Usuária da B");
  });

  it("does not delete another company's user", async () => {
    const response = await app.inject({
      method: "DELETE",
      url: `/user/delete-user/${B_OWNED.deletableUserId}`,
      headers: asA(),
    });

    await expectRefused(response, "apagar usuária da B");

    expect(
      await prisma.user.count({ where: { id: B_OWNED.deletableUserId } }),
    ).toBe(1);
  });

  it("does not revoke another company's user", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: `/user/revoke-access/${B_OWNED.userId}`,
      headers: asA(),
    });

    await expectRefused(response, "revogar usuária da B");

    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: B_OWNED.userId } }))
        .access_revoked,
    ).toBe(false);
  });
});

describe("writing to another carrier's permissions", () => {
  it("does not edit another company's profile", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: `/profile-access/update-profile-access/${B_OWNED.profileAccessId}`,
      headers: asA(),
      // No businessId: the edit body refuses it (decision 16.100).
      payload: { name: "Perfil Sequestrado" },
    });

    await expectRefused(response, "editar perfil da B");

    expect(
      (
        await prisma.profileAccess.findUniqueOrThrow({
          where: { id: B_OWNED.profileAccessId },
        })
      ).name,
    ).toBe("Perfil da B");
  });

  it("does not delete another company's profile", async () => {
    const response = await app.inject({
      method: "DELETE",
      url: `/profile-access/delete-profile-access/${B_OWNED.profileAccessId}`,
      headers: asA(),
    });

    await expectRefused(response, "apagar perfil da B");

    expect(
      await prisma.profileAccess.count({
        where: { id: B_OWNED.profileAccessId },
      }),
    ).toBe(1);
  });

  it("does not widen a permission that belongs to another company", async () => {
    // The worst of the set: a write here is privilege escalation inside
    // somebody else's tenant, and it leaves no trace on our side.
    const response = await app.inject({
      method: "PATCH",
      url: `/permission/update-permission/${B_OWNED.permissionId}`,
      headers: asA(),
      payload: {
        canRead: true,
        canWrite: true,
        profileAccessId: profileA,
      },
    });

    await expectRefused(response, "ampliar permissão da B");
  });

  it("does not delete a permission that belongs to another company", async () => {
    const response = await app.inject({
      method: "DELETE",
      url: `/permission/delete-permission/${B_OWNED.permissionId}`,
      headers: asA(),
    });

    await expectRefused(response, "apagar permissão da B");

    expect(
      await prisma.permission.count({ where: { id: B_OWNED.permissionId } }),
    ).toBe(1);
  });
});

describe("reading another carrier's operation", () => {
  it("does not follow another company's driver around", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/route/driver-trail/${B_OWNED.driverId}`,
      headers: asA(),
    });

    if (response.statusCode === 200) {
      const body = response.json();
      const rows = body.data?.positions ?? body.data ?? body;

      expect(
        Array.isArray(rows) ? rows.length : 0,
        "trilha de outro motorista veio preenchida",
      ).toBe(0);

      return;
    }

    await expectRefused(response, "trilha do motorista da B");
  });

  it("does not read the refuelling history of another company's vehicle", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/fuel/search-fuel-by-vehicle/${B_OWNED.vehicleId}`,
      headers: asA(),
    });

    if (response.statusCode === 200) {
      const body = response.json();
      const rows = body.data?.fuels ?? body.data ?? body;

      expect(
        JSON.stringify(rows),
        "litros, valor e odômetro da B vazaram",
      ).not.toContain("720");

      return;
    }

    await expectRefused(response, "abastecimentos da B");
  });

  it("does not read the last refuelling of another company's vehicle", async () => {
    const response = await app.inject({
      method: "GET",
      url:
        `/fuel/get-previous-fuel/${B_OWNED.vehicleId}` +
        `?businessId=${A}&date=${new Date().toISOString()}`,
      headers: asA(),
    });

    if (response.statusCode === 200) {
      expect(response.body, "o último abastecimento da B vazou").not.toContain(
        "10500",
      );

      return;
    }

    await expectRefused(response, "último abastecimento da B");
  });

  it("does not read the maintenance of another company's vehicle", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/service-order/search-service-order-by-vehicle/${B_OWNED.vehicleId}`,
      headers: asA(),
    });

    if (response.statusCode === 200) {
      expect(response.body, "a ordem de serviço da B vazou").not.toContain(
        "Revisão da B",
      );

      return;
    }

    await expectRefused(response, "ordens de serviço da B");
  });
});

describe("another carrier's notifications", () => {
  it("does not mark somebody else's notification as read", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: `/notification/${B_OWNED.notificationId}/read`,
      headers: asA(),
    });

    await expectRefused(response, "marcar notificação da B como lida");

    expect(
      (
        await prisma.notification.findUniqueOrThrow({
          where: { id: B_OWNED.notificationId },
        })
      ).read,
    ).toBe(false);
  });

  it("does not delete somebody else's notification", async () => {
    const response = await app.inject({
      method: "DELETE",
      url: `/notification/${B_OWNED.notificationId}`,
      headers: asA(),
    });

    await expectRefused(response, "apagar notificação da B");

    expect(
      await prisma.notification.count({
        where: { id: B_OWNED.notificationId },
      }),
    ).toBe(1);
  });
});
