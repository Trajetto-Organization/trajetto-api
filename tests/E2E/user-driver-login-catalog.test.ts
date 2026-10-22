import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { sign } from "jsonwebtoken";
import { container } from "tsyringe";

import auth from "@/config/auth";

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

const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const A = randomUUID();
const B = randomUUID();

let cnpj = 52000000000100 + Math.floor(Math.random() * 1_000_000);

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
