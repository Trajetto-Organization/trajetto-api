import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { randomUUID } from "node:crypto";

import { sign } from "jsonwebtoken";
import { container } from "tsyringe";

import auth from "@/config/auth";
import { createPrismaClient } from "@/shared/database/database-client";

import { seedFleetDriver } from "./support/fleet-driver-seed";

/**
 * A driver's app login is part of the driver catalogue the web reads: the
 * chat pickers split "com o app" from "sem o app" under the `driver` keys.
 * Creating, re-linking, revoking, restoring or deleting that login tells the
 * company's open tabs (`catalogChanged` driver, decision 2.3), after the
 * commit. A login without a driver is not part of that catalogue and says
 * nothing.
 */
const events = vi.hoisted(() => ({
  catalog: [] as Array<{ businessId: string; entity: string }>,
}));

vi.mock("@/websocket", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/websocket")>();

  return {
    ...actual,
    sendCatalogChangedEvent: (businessId: string, entity: string) => {
      events.catalog.push({ businessId, entity });
    },
    sendSecurityEventToUser: () => undefined,
    refreshDeliveryRooms: async () => undefined,
  };
});

const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const A = randomUUID();
const B = randomUUID();

let cnpj = 52000000000100 + Math.floor(Math.random() * 1_000_000);

async function seedBusiness(id: string): Promise<void> {
  cnpj += 1;

  await prisma.business.create({
    data: {
      id,
      corporate_reason: `Transportadora ${id}`,
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
}

async function seedDriver(businessId: string, name: string): Promise<string> {
  const suffix = randomUUID().replace(/\D/g, "").slice(0, 9).padEnd(9, "0");

  const driver = await prisma.driver.create({
    data: {
      name,
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

interface Seeded {
  id: string;
  token: string;
}

async function seedUser(data: {
  role: "MASTER" | "BUSINESS_ADMIN" | "BUSINESS_USER";
  businessId: string | null;
  profileAccessId?: string | null;
  driverId?: string | null;
}): Promise<Seeded> {
  const id = randomUUID();
  const familyId = randomUUID();

  await prisma.user.create({
    data: {
      id,
      name: "Pessoa Cadastrada",
      email: `${id}@exemplo.com.br`,
      password:
        "$2a$08$hash.que.nao.importa.neste.teste..........................",
      role: data.role,
      businessId: data.businessId,
      profileAccessId: data.profileAccessId ?? null,
      driverId: data.driverId ?? null,
    },
  });

  // The session the token belongs to: a token without a live family is refused.
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
      {
        subject: id,
        expiresIn: "30m",
      },
    ),
  };
}

async function send(
  method: "POST" | "PATCH" | "DELETE",
  url: string,
  token: string,
  payload?: Record<string, unknown>,
) {
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    payload,
  });
}

let admin: Seeded;
let master: Seeded;
let profileA = "";

beforeAll(async () => {
  await seedBusiness(A);
  await seedBusiness(B);

  const profile = await prisma.profileAccess.create({
    data: { name: "Operação", businessId: A },
  });
  await prisma.permission.create({
    data: {
      action: "kanban_manage",
      permissionKey: "kanban_manage",
      canRead: true,
      canWrite: false,
      businessId: A,
      profileAccessId: profile.id,
    },
  });
  profileA = profile.id;

  admin = await seedUser({ role: "BUSINESS_ADMIN", businessId: A });
  master = await seedUser({ role: "MASTER", businessId: null });

  ({ app } = await import("@/http"));
  await app.ready();

  // No real mail leaves a test.
  container.registerInstance("MailProvider", {
    sendMail: async () => ({ messageId: `<${randomUUID()}@x>` }),
  });
}, 120_000);

beforeEach(() => {
  events.catalog.length = 0;
});

afterAll(async () => {
  await app?.close();
  await prisma.business.deleteMany({ where: { id: { in: [A, B] } } });
  await prisma.user.deleteMany({ where: { id: master.id } });
  await prisma.$disconnect();
});

const DRIVER_CHANGED = { businessId: A, entity: "driver" };

describe("a driver's app login tells the driver catalogue", () => {
  it("when it is created, and not when a staff login is", async () => {
    const driverId = await seedDriver(A, "Motorista Criado");

    const created = await send("POST", "/user/create-user", admin.token, {
      name: "Motorista Criado",
      email: `${randomUUID()}@exemplo.com.br`,
      role: "BUSINESS_USER",
      businessId: A,
      driverId,
      userType: "driver",
    });

    expect(created.statusCode, created.body).toBe(201);
    expect(events.catalog).toEqual([DRIVER_CHANGED]);

    events.catalog.length = 0;

    const staff = await send("POST", "/user/create-user", admin.token, {
      name: "Colaboradora Nova",
      email: `${randomUUID()}@exemplo.com.br`,
      role: "BUSINESS_USER",
      businessId: A,
      profileAccessId: profileA,
      userType: "employee",
    });

    expect(staff.statusCode, staff.body).toBe(201);
    expect(events.catalog).toEqual([]);
  });

  it("when it moves to another driver or leaves the driver, and not on a rename", async () => {
    const first = await seedDriver(A, "Motorista Um");
    const second = await seedDriver(A, "Motorista Dois");
    const login = await seedUser({
      role: "BUSINESS_USER",
      businessId: A,
      driverId: first,
    });

    const renamed = await send(
      "PATCH",
      `/user/update-user/${login.id}`,
      admin.token,
      {
        name: "Nome Novo Completo",
      },
    );
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(events.catalog).toEqual([]);

    const relinked = await send(
      "PATCH",
      `/user/update-user/${login.id}`,
      admin.token,
      {
        driverId: second,
        userType: "driver",
      },
    );
    expect(relinked.statusCode, relinked.body).toBe(200);
    expect(events.catalog).toEqual([DRIVER_CHANGED]);

    events.catalog.length = 0;

    const toStaff = await send(
      "PATCH",
      `/user/update-user/${login.id}`,
      admin.token,
      {
        profileAccessId: profileA,
      },
    );
    expect(toStaff.statusCode, toStaff.body).toBe(200);
    expect(events.catalog).toEqual([DRIVER_CHANGED]);
  });

  it("when its access is revoked and when it is restored", async () => {
    const driverId = await seedDriver(A, "Motorista Revogado");
    const login = await seedUser({
      role: "BUSINESS_USER",
      businessId: A,
      driverId,
    });

    const revoked = await send(
      "PATCH",
      `/user/revoke-access/${login.id}`,
      admin.token,
    );
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect(events.catalog).toEqual([DRIVER_CHANGED]);

    events.catalog.length = 0;

    const restored = await send(
      "PATCH",
      `/user/revoke-access/${login.id}`,
      admin.token,
    );
    expect(restored.statusCode, restored.body).toBe(200);
    expect(events.catalog).toEqual([DRIVER_CHANGED]);
  });

  it("when it is deleted; a staff login deleted says nothing", async () => {
    const driverId = await seedDriver(A, "Motorista Excluído");
    const login = await seedUser({
      role: "BUSINESS_USER",
      businessId: A,
      driverId,
    });

    const deleted = await send(
      "DELETE",
      `/user/delete-user/${login.id}`,
      admin.token,
    );
    expect(deleted.statusCode, deleted.body).toBe(200);
    expect(events.catalog).toEqual([DRIVER_CHANGED]);

    events.catalog.length = 0;

    const staff = await seedUser({
      role: "BUSINESS_USER",
      businessId: A,
      profileAccessId: profileA,
    });
    const staffDeleted = await send(
      "DELETE",
      `/user/delete-user/${staff.id}`,
      admin.token,
    );
    expect(staffDeleted.statusCode, staffDeleted.body).toBe(200);
    expect(events.catalog).toEqual([]);
  });

  it("a login responsible for a bill is kept, as a conflict (409), and tells nobody", async () => {
    const driverId = await seedDriver(A, "Motorista Responsável");
    const login = await seedUser({
      role: "BUSINESS_USER",
      businessId: A,
      driverId,
    });

    const branch = await prisma.branch.create({
      data: {
        corporate_reason: `Filial ${randomUUID().slice(0, 8)}`,
        cep: "01001000",
        city: "São Paulo",
        uf: "SP",
        street: "Rua",
        address_number: "1",
        cnpj: `78${Math.floor(Math.random() * 1e12)}`
          .padEnd(14, "0")
          .slice(0, 14),
        cnae: "4930202",
        responsible_name: "Responsável",
        telephone: "11999999999",
        email: `filial-${randomUUID()}@exemplo.com.br`,
        businessId: A,
      },
    });

    await prisma.accountPayable.create({
      data: {
        businessId: A,
        branchId: branch.id,
        registrationUserId: login.id,
        amount: 100,
        due_date: new Date("2026-10-10T00:00:00.000Z"),
      },
    });

    const refused = await send(
      "DELETE",
      `/user/delete-user/${login.id}`,
      admin.token,
    );

    expect(refused.statusCode, refused.body).toBe(409);
    expect(JSON.parse(refused.body).code).toBe("USER_HAS_ACCOUNT_PAYABLES");
    expect(await prisma.user.count({ where: { id: login.id } })).toBe(1);
    expect(events.catalog).toEqual([]);
  });

  it("a user who left a record behind is kept, as a conflict (409) that points to revoking, not a 500", async () => {
    const staff = await seedUser({
      role: "BUSINESS_USER",
      businessId: A,
      profileAccessId: profileA,
    });

    // An upload is a record of something a person did: its FK is RESTRICT,
    // like the delivery events (a tower decision among them).
    await prisma.import.create({
      data: {
        source: "SPREADSHEET",
        filename: "entregas.xlsx",
        report: [],
        businessId: A,
        performedById: staff.id,
      },
    });

    const refused = await send(
      "DELETE",
      `/user/delete-user/${staff.id}`,
      admin.token,
    );

    expect(refused.statusCode, refused.body).toBe(409);
    expect(JSON.parse(refused.body).code).toBe("USER_HAS_RECORDS");
    expect(JSON.parse(refused.body).message).toMatch(/revogue o acesso/i);
    expect(await prisma.user.count({ where: { id: staff.id } })).toBe(1);
  });

  it("a refused edit tells nobody", async () => {
    const driverId = await seedDriver(B, "Motorista de Outra");
    const login = await seedUser({
      role: "BUSINESS_USER",
      businessId: A,
      profileAccessId: profileA,
    });

    // A driver of another company: refused before anything is written.
    const refused = await send(
      "PATCH",
      `/user/update-user/${login.id}`,
      admin.token,
      {
        driverId,
        userType: "driver",
      },
    );

    expect(refused.statusCode).toBeGreaterThanOrEqual(400);
    expect(events.catalog).toEqual([]);
  });
});

/**
 * Deleting a login is for one made by mistake; whoever worked has the access
 * revoked (batch of 14/11/2026, docs/arquitetura.md "Excluir x
 * inativar/revogar"). Before it, a driver's login was deleted with its route
 * still open — starting a route writes no row naming the login, so no
 * foreign key held it — and moved to another driver with the history it had
 * signed. Every refusal here changes nothing and tells nobody.
 */
describe("deleting or moving a driver's login", () => {
  let routeCode = 9_000 + Math.floor(Math.random() * 100_000);

  async function openRoute(
    driverId: string,
    status: "RELEASED" | "IN_PROGRESS",
  ) {
    routeCode += 1;

    return prisma.route.create({
      data: {
        code: routeCode,
        name: "Rota do teste",
        scheduled_date: new Date("2026-11-14T00:00:00Z"),
        status,
        ...(status === "IN_PROGRESS" && { started_at: new Date() }),
        businessId: A,
        driverId,
      },
    });
  }

  async function arrivalBy(userId: string): Promise<string> {
    const shipper = await prisma.shipper.create({
      data: { name: `Embarcador ${randomUUID().slice(0, 8)}`, businessId: A },
    });
    const delivery = await prisma.delivery.create({
      data: {
        recipient_name: "Mercado",
        city: "São Paulo",
        uf: "SP",
        street: "Rua",
        businessId: A,
        shipperId: shipper.id,
      },
    });

    await prisma.deliveryEvent.create({
      data: {
        type: "ARRIVAL",
        deliveryId: delivery.id,
        businessId: A,
        reportedById: userId,
        actor: "USER",
      },
    });

    return delivery.id;
  }

  it("keeps a driver's login whose route is released (409 DRIVER_HAS_OPEN_ROUTES)", async () => {
    const driverId = await seedDriver(A, "Motorista Com Rota");
    const login = await seedUser({
      role: "BUSINESS_USER",
      businessId: A,
      driverId,
    });
    const route = await openRoute(driverId, "RELEASED");

    try {
      const refused = await send(
        "DELETE",
        `/user/delete-user/${login.id}`,
        admin.token,
      );

      expect(refused.statusCode, refused.body).toBe(409);
      expect(JSON.parse(refused.body)).toMatchObject({
        code: "DRIVER_HAS_OPEN_ROUTES",
        message: expect.stringContaining("Não é possível excluir este usuário"),
      });
      expect(await prisma.user.count({ where: { id: login.id } })).toBe(1);
      expect(events.catalog).toEqual([]);
    } finally {
      await prisma.route.delete({ where: { id: route.id } });
    }
  });

  it("keeps a login that reported an arrival, naming the count (409 USER_HAS_RECORDS)", async () => {
    const driverId = await seedDriver(A, "Motorista Que Chegou");
    const login = await seedUser({
      role: "BUSINESS_USER",
      businessId: A,
      driverId,
    });
    const deliveryId = await arrivalBy(login.id);

    try {
      const refused = await send(
        "DELETE",
        `/user/delete-user/${login.id}`,
        admin.token,
      );

      expect(refused.statusCode, refused.body).toBe(409);
      expect(JSON.parse(refused.body)).toMatchObject({
        code: "USER_HAS_RECORDS",
        message: expect.stringContaining("1 evento(s) de entrega"),
      });
      expect(JSON.parse(refused.body).message).toMatch(/revogue o acesso/i);
      expect(await prisma.user.count({ where: { id: login.id } })).toBe(1);
    } finally {
      await prisma.delivery.delete({ where: { id: deliveryId } });
    }
  });

  it("deletes a driver's login that only refueled and inspected, and the driver keeps both (200)", async () => {
    // Fuelings and checklists belong to the Driver row, not to the login.
    cnpj += 1;
    const C = randomUUID();
    const seed = await seedFleetDriver(prisma, {
      businessId: C,
      cnpj: String(cnpj),
    });

    await prisma.fuel.create({
      data: {
        current_mileage: 1000,
        liters_amount: 50,
        price_per_liter: 6,
        total_amount: 300,
        odometer_photo: `odometerPhotos/${C}/${randomUUID()}.jpg`,
        odometer_ai_status: "skipped",
        businessId: C,
        branchId: seed.branchId,
        vehicleId: seed.vehicleId,
        driverId: seed.driverId,
        fuelTypeId: seed.fuelTypeId,
      },
    });
    await prisma.vehicleChecklist.create({
      data: {
        current_mileage: 1000,
        tires_condition: "good",
        bumpers_condition: "good",
        windshield_condition: "good",
        mirrors_condition: "good",
        steering_wheel_condition: "good",
        battery_condition: "good",
        spare_tire_condition: "good",
        overall_condition: "approved",
        fuel_level_adequate: true,
        ai_verification_status: "skipped",
        businessId: C,
        branchId: seed.branchId,
        vehicleId: seed.vehicleId,
        driverId: seed.driverId,
      },
    });

    const deleted = await send(
      "DELETE",
      `/user/delete-user/${seed.driverUserId}`,
      seed.managerToken,
    );

    expect(deleted.statusCode, deleted.body).toBe(200);
    expect(await prisma.user.count({ where: { id: seed.driverUserId } })).toBe(
      0,
    );
    expect(await prisma.driver.count({ where: { id: seed.driverId } })).toBe(1);
    expect(
      await prisma.fuel.count({ where: { driverId: seed.driverId } }),
    ).toBe(1);
    expect(
      await prisma.vehicleChecklist.count({
        where: { driverId: seed.driverId },
      }),
    ).toBe(1);
  });

  it("keeps an office user who wrote in the chat (409 USER_HAS_RECORDS)", async () => {
    const driverId = await seedDriver(A, "Motorista da Conversa");
    const staff = await seedUser({
      role: "BUSINESS_USER",
      businessId: A,
      profileAccessId: profileA,
    });
    const thread = await prisma.chatThread.create({
      data: { businessId: A, driverId },
    });

    await prisma.chatMessage.create({
      data: {
        kind: "TEXT",
        body: "Bom dia, pode seguir para a próxima parada.",
        threadId: thread.id,
        senderId: staff.id,
      },
    });

    try {
      const refused = await send(
        "DELETE",
        `/user/delete-user/${staff.id}`,
        admin.token,
      );

      expect(refused.statusCode, refused.body).toBe(409);
      expect(JSON.parse(refused.body)).toMatchObject({
        code: "USER_HAS_RECORDS",
        message: expect.stringContaining("1 mensagem(ns) no chat"),
      });
      expect(await prisma.user.count({ where: { id: staff.id } })).toBe(1);
    } finally {
      await prisma.chatThread.delete({ where: { id: thread.id } });
    }
  });

  it("refuses taking a login off a driver with a route in progress, changing nothing (409)", async () => {
    const first = await seedDriver(A, "Motorista Na Rua");
    const second = await seedDriver(A, "Motorista Livre");
    const login = await seedUser({
      role: "BUSINESS_USER",
      businessId: A,
      driverId: first,
    });
    const route = await openRoute(first, "IN_PROGRESS");

    await prisma.driverTrustedDevice.create({
      data: { userId: login.id, device_hash: "b".repeat(64), source: "qr" },
    });

    try {
      for (const payload of [
        { driverId: second, userType: "driver" },
        { profileAccessId: profileA },
      ]) {
        const refused = await send(
          "PATCH",
          `/user/update-user/${login.id}`,
          admin.token,
          payload,
        );

        expect(refused.statusCode, refused.body).toBe(409);
        expect(JSON.parse(refused.body).code).toBe("DRIVER_HAS_OPEN_ROUTES");
      }

      const after = await prisma.user.findUniqueOrThrow({
        where: { id: login.id },
      });

      expect(after.driverId).toBe(first);
      expect(after.session_version).toBe(0);
      expect(
        await prisma.driverTrustedDevice.count({ where: { userId: login.id } }),
      ).toBe(1);
      expect(events.catalog).toEqual([]);
    } finally {
      await prisma.route.delete({ where: { id: route.id } });
    }
  });

  it("refuses handing a login with history to another driver (409 USER_DRIVER_LOCKED)", async () => {
    const first = await seedDriver(A, "Motorista Antigo");
    const second = await seedDriver(A, "Motorista Novo");
    const login = await seedUser({
      role: "BUSINESS_USER",
      businessId: A,
      driverId: first,
    });
    const deliveryId = await arrivalBy(login.id);

    try {
      const refused = await send(
        "PATCH",
        `/user/update-user/${login.id}`,
        admin.token,
        { driverId: second, userType: "driver" },
      );

      expect(refused.statusCode, refused.body).toBe(409);
      expect(JSON.parse(refused.body)).toMatchObject({
        code: "USER_DRIVER_LOCKED",
        message: expect.stringContaining("Crie outro login"),
      });
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: login.id } }))
          .driverId,
      ).toBe(first);
      expect(events.catalog).toEqual([]);
    } finally {
      await prisma.delivery.delete({ where: { id: deliveryId } });
    }
  });

  it("moves a login without a route or history to another driver, as before (200)", async () => {
    const first = await seedDriver(A, "Motorista De Antes");
    const second = await seedDriver(A, "Motorista De Agora");
    const login = await seedUser({
      role: "BUSINESS_USER",
      businessId: A,
      driverId: first,
    });

    const moved = await send(
      "PATCH",
      `/user/update-user/${login.id}`,
      admin.token,
      { driverId: second, userType: "driver" },
    );

    expect(moved.statusCode, moved.body).toBe(200);
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: login.id } }))
        .driverId,
    ).toBe(second);
  });
});
