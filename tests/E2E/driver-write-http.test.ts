import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { sign } from "jsonwebtoken";

import { randomUUID } from "node:crypto";

import auth from "@/config/auth";
import { pauseTypeId } from "./support/pause-type-seed";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * Registering, editing and deleting drivers over real HTTP and Postgres:
 * the licence fields (decision 8.5), CPF and CNH unique per company with a
 * 409 that speaks of nobody else (decision 8.1), deactivation refused while
 * routes still need the driver (decision 8.3), and a delete that no longer
 * ends in a 500 on the pause table's RESTRICT key.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018fe600-0000-7000-8000-00000000000a";
const OTHER = "018fe600-0000-7000-8000-00000000000b";
/** A carrier the MASTER switched off: its catalogue is read-only. */
const INACTIVE = "018fe600-0000-7000-8000-00000000000c";

const tokens: Record<
  "admin" | "readOnly" | "otherAdmin" | "master" | "driver",
  string
> = {} as never;

let cnpjSeq = 0;
let docSeq = 0;

async function seedBusiness(id: string, isActive = true) {
  cnpjSeq += 1;

  await prisma.business.create({
    data: {
      id,
      is_active: isActive,
      corporate_reason: `Transportadora ${id.slice(-1)}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua das Transportadoras",
      address_number: "1",
      cnpj: String(61222555000180 + cnpjSeq),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `${id}@exemplo.com.br`,
    },
  });
}

async function seedUser(
  role: "MASTER" | "BUSINESS_ADMIN" | "BUSINESS_USER",
  businessId: string | null,
  profileAccessId?: string,
  driverId?: string,
): Promise<string> {
  const id = randomUUID();
  const familyId = randomUUID();

  await prisma.user.create({
    data: {
      id,
      name: `Usuário ${id.slice(0, 4)}`,
      email: `${id}@exemplo.com.br`,
      password: "not-used-here",
      role,
      businessId,
      profileAccessId: profileAccessId ?? null,
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

  return sign(
    { tokenType: "access", sessionVersion: 0, familyId },
    auth.secret_token,
    {
      subject: id,
      expiresIn: "15m",
    },
  );
}

/** What the web form posts (after its own masks are stripped by the schema). */
function body(overrides: Record<string, unknown> = {}) {
  docSeq += 1;

  return {
    name: "Joana Motorista",
    birth_date: "1990-05-10T03:00:00.000Z",
    cnh: `7${String(docSeq).padStart(10, "0")}`,
    cpf: `8${String(docSeq).padStart(10, "0")}`,
    rg: "123456789",
    cep: "01001-000",
    city: "São Paulo",
    uf: "SP",
    street: "Rua das Flores",
    address_number: "10",
    status: "ACTIVE",
    contract_type: "OWNED",
    ...overrides,
  };
}

async function create(
  businessId: string,
  payload: object,
  token = tokens.admin,
) {
  return app.inject({
    method: "POST",
    url: `/driver/create-driver/${businessId}`,
    headers: { authorization: `Bearer ${token}` },
    payload,
  });
}

async function update(
  driverId: string,
  businessId: string,
  payload: object,
  token = tokens.admin,
) {
  return app.inject({
    method: "PATCH",
    url: `/driver/update-driver/${driverId}/business/${businessId}`,
    headers: { authorization: `Bearer ${token}` },
    payload,
  });
}

async function remove(
  driverId: string,
  businessId: string,
  token = tokens.admin,
) {
  return app.inject({
    method: "DELETE",
    url: `/driver/delete-driver/${driverId}/business/${businessId}`,
    headers: { authorization: `Bearer ${token}` },
  });
}

async function createdId(businessId: string, payload: { cpf: string }) {
  const row = await prisma.driver.findUniqueOrThrow({
    where: { businessId_cpf: { businessId, cpf: payload.cpf } },
  });

  return row.id;
}

let routeCode = 0;

async function seedRoute(
  driverId: string,
  status: "PLANNED" | "RELEASED" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED",
) {
  routeCode += 1;

  await prisma.route.create({
    data: {
      code: routeCode,
      name: `Rota ${routeCode}`,
      scheduled_date: new Date("2026-09-28T00:00:00.000Z"),
      businessId: CARRIER,
      driverId,
      status,
    },
  });
}

beforeAll(async () => {
  await seedBusiness(CARRIER);
  await seedBusiness(OTHER);
  await seedBusiness(INACTIVE, false);

  const readOnlyProfile = await prisma.profileAccess.create({
    data: {
      name: "Leitura de motoristas",
      businessId: CARRIER,
      permissions: {
        create: [
          {
            permissionKey: "driver_manage",
            action: "driver_manage",
            canRead: true,
            canWrite: false,
            businessId: CARRIER,
          },
        ],
      },
    },
  });

  tokens.admin = await seedUser("BUSINESS_ADMIN", CARRIER);
  tokens.readOnly = await seedUser(
    "BUSINESS_USER",
    CARRIER,
    readOnlyProfile.id,
  );
  tokens.otherAdmin = await seedUser("BUSINESS_ADMIN", OTHER);
  tokens.master = await seedUser("MASTER", null);

  // The app user of a driver of this company: the driver map grants no
  // catalogue writes.
  const appDriver = await prisma.driver.create({
    data: {
      ...body(),
      cep: "01001000",
      birth_date: new Date("1990-05-10T00:00:00.000Z"),
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId: CARRIER,
    },
  });
  tokens.driver = await seedUser(
    "BUSINESS_USER",
    CARRIER,
    undefined,
    appDriver.id,
  );

  ({ app } = await import("@/http"));
  await app.ready();
}, 90_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

describe("the licence fields (decision 8.5)", () => {
  it("stores the category and the expiry as the civil day typed", async () => {
    const payload = body({ cnh_category: "AE", cnh_expires_at: "2030-03-17" });
    const response = await create(CARRIER, payload);

    expect(response.statusCode).toBe(201);

    const row = await prisma.driver.findUniqueOrThrow({
      where: { businessId_cpf: { businessId: CARRIER, cpf: payload.cpf } },
    });

    expect(row.cnh_category).toBe("AE");
    // A date column: the 17th, whatever the zone of the server or the client.
    expect(row.cnh_expires_at?.toISOString()).toBe("2030-03-17T00:00:00.000Z");
  });

  it("accepts both as empty, for the drivers who do not have them on file", async () => {
    const payload = body({ cnh_category: "", cnh_expires_at: "" });

    expect((await create(CARRIER, payload)).statusCode).toBe(201);

    const row = await prisma.driver.findUniqueOrThrow({
      where: { businessId_cpf: { businessId: CARRIER, cpf: payload.cpf } },
    });

    expect(row.cnh_category).toBeNull();
    expect(row.cnh_expires_at).toBeNull();
  });

  it("refuses an unknown category, an instant, an impossible day and a date too far ahead", async () => {
    const cases = [
      [{ cnh_category: "F" }, "categoria da CNH"],
      [{ cnh_expires_at: "2030-03-17T10:00:00Z" }, "AAAA-MM-DD"],
      [{ cnh_expires_at: "2030-02-30" }, "não é uma data válida"],
      [{ cnh_expires_at: "2099-01-01" }, "10 anos"],
      [{ cnh: "123" }, "11 dígitos"],
    ] as const;

    for (const [override, message] of cases) {
      const response = await create(CARRIER, body(override));

      expect(response.statusCode, JSON.stringify(override)).toBe(400);
      expect(response.body).toContain(message);
    }
  });

  it("clears the expiry on edit when it is sent empty", async () => {
    const payload = body({ cnh_expires_at: "2029-01-01" });
    await create(CARRIER, payload);
    const id = await createdId(CARRIER, payload);

    const response = await update(id, CARRIER, {
      birth_date: payload.birth_date,
      cnh_expires_at: "",
    });

    expect(response.statusCode).toBe(200);
    expect(
      (await prisma.driver.findUniqueOrThrow({ where: { id } })).cnh_expires_at,
    ).toBeNull();
  });
});

describe("the birth date, a civil day (decision 1.3)", () => {
  it("stores the day the form sends as UTC midnight, and the legacy instant as the same day", async () => {
    const dateOnly = body({ birth_date: "1990-05-10" });
    const legacy = body({ birth_date: "1990-05-10T03:00:00.000Z" });

    // A bare "YYYY-MM-DD" used to reach Prisma as a string it refuses: a 500.
    expect((await create(CARRIER, dateOnly)).statusCode).toBe(201);
    expect((await create(CARRIER, legacy)).statusCode).toBe(201);

    for (const payload of [dateOnly, legacy]) {
      const row = await prisma.driver.findUniqueOrThrow({
        where: { businessId_cpf: { businessId: CARRIER, cpf: payload.cpf } },
      });

      expect(row.birth_date.toISOString()).toBe("1990-05-10T00:00:00.000Z");
    }
  });

  it("refuses a driver under 18 and a date that is not one", async () => {
    const tooYoung = await create(CARRIER, body({ birth_date: "2015-01-01" }));
    const garbage = await create(CARRIER, body({ birth_date: "10/05/1990" }));

    expect(tooYoung.statusCode).toBe(400);
    expect(tooYoung.body).toContain("pelo menos 18 anos");
    expect(garbage.statusCode).toBe(400);
    expect(garbage.body).toContain("Data de nascimento inválida");
  });
});

describe("CPF and CNH unique per company (decision 8.1)", () => {
  it("lets two carriers register the same independent driver", async () => {
    const payload = body();

    expect((await create(CARRIER, payload)).statusCode).toBe(201);
    expect((await create(OTHER, payload, tokens.otherAdmin)).statusCode).toBe(
      201,
    );
  });

  it("refuses a CPF already in THIS company with a 409 that names only it", async () => {
    const first = body();
    await create(CARRIER, first);

    const response = await create(CARRIER, body({ cpf: first.cpf }));
    const json = response.json();

    expect(response.statusCode).toBe(409);
    expect(json.code).toBe("DRIVER_CPF_ALREADY_EXISTS");
    expect(json.message).toContain("nesta empresa");
  });

  it("refuses a CNH already in THIS company", async () => {
    const first = body();
    await create(CARRIER, first);

    const response = await create(CARRIER, body({ cnh: first.cnh }));

    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("DRIVER_CNH_ALREADY_EXISTS");
  });

  it("answers another company's CPF as free, and the same one on edit as taken only inside", async () => {
    const theirs = body();
    await create(OTHER, theirs, tokens.otherAdmin);

    const mine = body();
    await create(CARRIER, mine);
    const mineId = await createdId(CARRIER, mine);

    // Taking the CPF another carrier uses: allowed, and says nothing about it.
    const response = await update(mineId, CARRIER, {
      birth_date: mine.birth_date,
      cpf: theirs.cpf,
    });

    expect(response.statusCode).toBe(200);
  });

  it("maps two concurrent registrations of the same CPF to one 201 and one 409, never a 500", async () => {
    const payload = body();

    const responses = await Promise.all([
      create(CARRIER, payload),
      create(CARRIER, { ...payload, cnh: body().cnh }),
    ]);

    expect(responses.map((response) => response.statusCode).sort()).toEqual([
      201, 409,
    ]);
  });
});

describe("deactivating a driver with routes (decision 8.3)", () => {
  it("is refused while a route is in progress, and the driver stays active", async () => {
    const payload = body();
    await create(CARRIER, payload);
    const id = await createdId(CARRIER, payload);

    await seedRoute(id, "IN_PROGRESS");
    await seedRoute(id, "PLANNED");
    await seedRoute(id, "RELEASED");

    const response = await update(id, CARRIER, {
      birth_date: payload.birth_date,
      status: "INACTIVE",
    });
    const json = response.json();

    expect(response.statusCode).toBe(409);
    expect(json.code).toBe("DRIVER_HAS_OPEN_ROUTES");
    expect(json.message).toContain(
      "1 rota em andamento e 2 rotas planejadas ou liberadas",
    );
    expect(
      (await prisma.driver.findUniqueOrThrow({ where: { id } })).status,
    ).toBe("ACTIVE");
  });

  it("goes through once the routes are finished or cancelled", async () => {
    const payload = body();
    await create(CARRIER, payload);
    const id = await createdId(CARRIER, payload);

    await seedRoute(id, "COMPLETED");
    await seedRoute(id, "CANCELLED");

    const response = await update(id, CARRIER, {
      birth_date: payload.birth_date,
      status: "INACTIVE",
    });

    expect(response.statusCode).toBe(200);
    expect(
      (await prisma.driver.findUniqueOrThrow({ where: { id } })).status,
    ).toBe("INACTIVE");
  });
});

describe("deleting a driver", () => {
  it("with pauses on record is a 409 with the count, not a 500 from the RESTRICT key", async () => {
    const payload = body();
    await create(CARRIER, payload);
    const id = await createdId(CARRIER, payload);

    await prisma.driverPause.create({
      data: {
        kind: "MEAL",
        started_at: new Date("2026-09-28T15:00:00.000Z"),
        ended_at: new Date("2026-09-28T16:00:00.000Z"),
        start_submission_id: randomUUID(),
        driverId: id,
        businessId: CARRIER,
        occurrenceTypeId: await pauseTypeId(prisma, CARRIER, "MEAL"),
      },
    });

    const response = await remove(id, CARRIER);

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "DRIVER_HAS_PAUSES" });
    expect(response.json().message).toContain("1 pausa(s)");
    expect(await prisma.driver.findUnique({ where: { id } })).not.toBeNull();
  });

  it("without history goes through", async () => {
    const payload = body();
    await create(CARRIER, payload);
    const id = await createdId(CARRIER, payload);

    expect((await remove(id, CARRIER)).statusCode).toBe(200);
    expect(await prisma.driver.findUnique({ where: { id } })).toBeNull();
  });
});

/**
 * A write of another request that is still open: `work` runs inside a
 * transaction of the test's own connection, which stays uncommitted until
 * `release()` — the window a concurrent request lands in.
 */
function holdOpen(
  work: (
    tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  ) => Promise<unknown>,
) {
  let release!: () => void;
  let markReady!: () => void;

  const released = new Promise<void>((resolve) => (release = resolve));
  const ready = new Promise<void>((resolve) => (markReady = resolve));

  const done = prisma.$transaction(
    async (tx) => {
      await work(tx);
      markReady();
      await released;
    },
    { maxWait: 10_000, timeout: 30_000 },
  );

  return { ready, release, done };
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("writes racing another request (the driver row's lock)", () => {
  it("refuses the deactivation when a route for the driver is being created at the same time", async () => {
    const payload = body();
    await create(CARRIER, payload);
    const id = await createdId(CARRIER, payload);

    routeCode += 1;
    const code = routeCode;

    const writer = holdOpen((tx) =>
      tx.route.create({
        data: {
          code,
          name: `Rota ${code}`,
          scheduled_date: new Date("2026-09-28T00:00:00.000Z"),
          businessId: CARRIER,
          driverId: id,
          status: "PLANNED",
        },
      }),
    );

    await writer.ready;

    // The count of a plain read would not see the uncommitted route, and the
    // status UPDATE does not conflict with the route's KEY SHARE lock: the
    // driver went inactive with a route waiting for them.
    const deactivation = update(id, CARRIER, {
      birth_date: payload.birth_date,
      status: "INACTIVE",
    });

    await pause(400);
    writer.release();
    await writer.done;

    const response = await deactivation;

    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("DRIVER_HAS_OPEN_ROUTES");
    expect(
      (await prisma.driver.findUniqueOrThrow({ where: { id } })).status,
    ).toBe("ACTIVE");
  });

  it("refuses the delete, with a 409 and not a 500, when a pause arrives while it runs", async () => {
    const payload = body();
    await create(CARRIER, payload);
    const id = await createdId(CARRIER, payload);

    const restTypeId = await pauseTypeId(prisma, CARRIER, "REST");

    const writer = holdOpen((tx) =>
      tx.driverPause.create({
        data: {
          kind: "REST",
          started_at: new Date("2026-09-28T15:00:00.000Z"),
          start_submission_id: randomUUID(),
          driverId: id,
          businessId: CARRIER,
          occurrenceTypeId: restTypeId,
        },
      }),
    );

    await writer.ready;

    // The guards' counts run before the pause commits and see nothing; the
    // DELETE then met the RESTRICT key and the use case answered 500.
    const deletion = remove(id, CARRIER);

    await pause(400);
    writer.release();
    await writer.done;

    const response = await deletion;

    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("DRIVER_HAS_PAUSES");
    expect(await prisma.driver.findUnique({ where: { id } })).not.toBeNull();
  });

  it("refuses the delete when an app user is linked to the driver while it runs", async () => {
    const payload = body();
    await create(CARRIER, payload);
    const id = await createdId(CARRIER, payload);

    const userId = randomUUID();

    const writer = holdOpen((tx) =>
      tx.user.create({
        data: {
          id: userId,
          name: "Conta do Motorista",
          email: `${userId}@exemplo.com.br`,
          password: "not-used-here",
          role: "BUSINESS_USER",
          businessId: CARRIER,
          driverId: id,
        },
      }),
    );

    await writer.ready;

    // `User.driver` is optional: the DELETE used to go through and set the
    // new account's driverId to NULL without a word.
    const deletion = remove(id, CARRIER);

    await pause(400);
    writer.release();
    await writer.done;

    const response = await deletion;

    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("DRIVER_HAS_USER");
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).driverId,
    ).toBe(id);
  });
});

describe("tenants and roles on the writes", () => {
  it("answers another company's driver as not found, on edit and on delete", async () => {
    const theirs = body();
    await create(OTHER, theirs, tokens.otherAdmin);
    const theirId = await createdId(OTHER, theirs);

    const edit = await update(theirId, CARRIER, {
      birth_date: theirs.birth_date,
      name: "Invasor Teste",
    });
    const drop = await remove(theirId, CARRIER);

    expect(edit.statusCode).toBe(404);
    expect(edit.json().code).toBe("DRIVER_NOT_FOUND");
    expect(drop.statusCode).toBe(404);
    expect(drop.json().code).toBe("DRIVER_NOT_FOUND");
    expect(
      (await prisma.driver.findUniqueOrThrow({ where: { id: theirId } })).name,
    ).toBe("Joana Motorista");
  });

  it("refuses another company's id in the path", async () => {
    const response = await create(OTHER, body());

    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("TENANT_ACCESS_DENIED");
  });

  it("refuses a read-only profile", async () => {
    const response = await create(CARRIER, body(), tokens.readOnly);

    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("PERMISSION_DENIED");
  });

  it("lets the master write in the company it names", async () => {
    expect((await create(OTHER, body(), tokens.master)).statusCode).toBe(201);
  });

  it("refuses a read-only profile and a driver token on edit and on delete", async () => {
    const payload = body();
    await create(CARRIER, payload);
    const id = await createdId(CARRIER, payload);

    for (const token of [tokens.readOnly, tokens.driver]) {
      const edit = await update(
        id,
        CARRIER,
        { birth_date: payload.birth_date, name: "Outro Nome" },
        token,
      );
      const drop = await remove(id, CARRIER, token);

      expect(edit.statusCode).toBe(403);
      expect(edit.json().code).toBe("PERMISSION_DENIED");
      expect(drop.statusCode).toBe(403);
      expect(drop.json().code).toBe("PERMISSION_DENIED");
    }

    const row = await prisma.driver.findUniqueOrThrow({ where: { id } });

    expect(row.name).toBe("Joana Motorista");
  });

  it("keeps a deactivated company read-only for the master: no edit, no delete", async () => {
    const driver = await prisma.driver.create({
      data: {
        ...body(),
        cep: "01001000",
        birth_date: new Date("1990-05-10T00:00:00.000Z"),
        status: "ACTIVE",
        contract_type: "OWNED",
        businessId: INACTIVE,
      },
    });

    const edit = await update(
      driver.id,
      INACTIVE,
      { birth_date: "1990-05-10", name: "Outro Nome" },
      tokens.master,
    );
    const drop = await remove(driver.id, INACTIVE, tokens.master);

    expect(edit.statusCode).toBe(403);
    expect(edit.json().code).toBe("TENANT_INACTIVE");
    // Before, the delete route had no tenant guard and removed the row.
    expect(drop.statusCode).toBe(403);
    expect(drop.json().code).toBe("TENANT_INACTIVE");
    expect(
      await prisma.driver.findUnique({ where: { id: driver.id } }),
    ).not.toBeNull();
  });
});
