import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { sign } from "jsonwebtoken";

import { randomUUID } from "node:crypto";

import auth from "@/config/auth";
import { businessDayRange } from "@/shared/time/business-day";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * Accounts payable over real HTTP and Postgres (decisions 8.4, 4.5, 8.8).
 *
 * - the status is the server's, by the company's business day, and the SQL
 *   filter agrees with it at the very boundary of the day;
 * - cards, filters and order are counted over the whole company;
 * - "minhas contas a pagar" works for the driver who is the responsible
 *   (it answered 403 since the permission was required);
 * - payee, cost centre, description, document and creator are stored;
 * - nothing crosses companies, and a bill never moves between them.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018fe200-0000-7000-8000-00000000000a";
const OTHER = "018fe200-0000-7000-8000-00000000000b";
// Switched off by the platform, with the module still hired.
const INACTIVE = "018fe200-0000-7000-8000-00000000000c";

const DRIVER = "018fe200-0000-7000-8000-0000000000d1";

const SP = "America/Sao_Paulo";

const tokens: Record<
  "admin" | "readOnly" | "noPayables" | "driver" | "otherAdmin" | "master",
  string
> = {} as never;

const ids: Record<
  | "admin"
  | "clerk"
  | "driverUser"
  | "branch"
  | "otherBranch"
  | "supplier"
  | "otherSupplier"
  | "vehicle"
  | "otherVehicle"
  | "serviceOrder"
  | "inactiveBranch",
  string
> = {} as never;

let cnpjSeq = 0;

async function seedBusiness(id: string, isActive = true): Promise<void> {
  cnpjSeq += 1;

  await prisma.business.create({
    data: {
      id,
      corporate_reason: `Transportadora ${id.slice(-1)}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua das Transportadoras",
      address_number: "1",
      cnpj: String(41222555000180 + cnpjSeq),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `${id}@exemplo.com.br`,
      timezone: SP,
      is_active: isActive,
    },
  });

  await prisma.businessEntitlement.create({
    data: { businessId: id, module: "FLEET", enabled: true },
  });
}

async function seedProfile(
  businessId: string,
  permissionKey: string,
  canWrite: boolean,
): Promise<string> {
  const profile = await prisma.profileAccess.create({
    data: {
      name: `Perfil ${randomUUID().slice(0, 8)}`,
      businessId,
      permissions: {
        create: [
          {
            permissionKey,
            action: permissionKey,
            canRead: true,
            canWrite,
            businessId,
          },
        ],
      },
    },
  });

  return profile.id;
}

async function seedUser(
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
      { subject: id, expiresIn: "15m" },
    ),
  };
}

async function seedBranch(businessId: string): Promise<string> {
  const branch = await prisma.branch.create({
    data: {
      corporate_reason: `Filial ${randomUUID().slice(0, 8)}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: `77${Math.floor(Math.random() * 1e12)}`
        .padEnd(14, "0")
        .slice(0, 14),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `filial-${randomUUID()}@exemplo.com.br`,
      businessId,
    },
  });

  return branch.id;
}

async function seedVehicle(businessId: string, plate: string): Promise<string> {
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

interface ListMeta {
  total: number;
  searchMeta: {
    total: number;
    open: number;
    overdue: number;
    paid: number;
    openAmount: number;
    overdueAmount: number;
    paidAmount: number;
    facets: { status: Array<{ value: string; count: number }> };
  };
}

interface Row {
  id: string;
  document_number: string | null;
  status: string;
  status_group: string;
  due_day: string;
  remaining_amount: number;
  supplier: { name: string } | null;
  vehicle: { license_plate: string } | null;
  createdBy: { name: string } | null;
  registrationUserId: string;
}

async function ndjson(
  url: string,
  token: string,
): Promise<{ status: number; meta: ListMeta; rows: Row[]; body: string }> {
  const response = await app.inject({
    method: "GET",
    url,
    headers: { authorization: `Bearer ${token}` },
  });

  if (response.statusCode !== 200) {
    return {
      status: response.statusCode,
      meta: {} as ListMeta,
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

const list = (query: string, token = tokens.admin) =>
  ndjson(
    `/account-payable/list-account-payable?page=1&pageSize=10${query ? `&${query}` : ""}`,
    token,
  );

const docs = (rows: Row[]) => rows.map((row) => row.document_number);

/**
 * Twelve bills of the carrier, more than a page of ten, relative to "today"
 * in São Paulo. The two that decide the boundary: B-EDGE-1 is due one
 * millisecond before today began (overdue), B-EDGE-2 at the instant today
 * began (due today: open).
 */
let todayStart: Date;

beforeAll(async () => {
  await seedBusiness(CARRIER);
  await seedBusiness(OTHER);
  await seedBusiness(INACTIVE, false);

  ids.branch = await seedBranch(CARRIER);
  ids.otherBranch = await seedBranch(OTHER);
  ids.inactiveBranch = await seedBranch(INACTIVE);

  ids.supplier = (
    await prisma.supplier.create({
      data: {
        name: "Oficina Central",
        cnpj: "11222333000181",
        businessId: CARRIER,
      },
    })
  ).id;
  ids.otherSupplier = (
    await prisma.supplier.create({
      data: {
        name: "Oficina Alheia",
        cnpj: "11222333000181",
        businessId: OTHER,
      },
    })
  ).id;

  ids.vehicle = await seedVehicle(CARRIER, "ABC1D23");
  ids.otherVehicle = await seedVehicle(OTHER, "XYZ9K88");

  await prisma.driver.create({
    data: {
      id: DRIVER,
      name: "Motorista",
      birth_date: new Date("1990-01-01"),
      cnh: `${DRIVER}-cnh`,
      cpf: `${DRIVER}-cpf`,
      rg: `${DRIVER}-rg`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId: CARRIER,
    },
  });

  const admin = await seedUser("Zélia Gestora", "BUSINESS_ADMIN", CARRIER);
  const clerk = await seedUser("Abel Financeiro", "BUSINESS_USER", CARRIER, {
    profileAccessId: await seedProfile(CARRIER, "account_payable_manage", true),
  });
  const driverUser = await seedUser("Motorista", "BUSINESS_USER", CARRIER, {
    driverId: DRIVER,
  });

  ids.admin = admin.id;
  ids.clerk = clerk.id;
  ids.driverUser = driverUser.id;

  tokens.admin = admin.token;
  tokens.driver = driverUser.token;
  tokens.readOnly = (
    await seedUser("Leitura", "BUSINESS_USER", CARRIER, {
      profileAccessId: await seedProfile(
        CARRIER,
        "account_payable_manage",
        false,
      ),
    })
  ).token;
  tokens.noPayables = (
    await seedUser("Frota", "BUSINESS_USER", CARRIER, {
      profileAccessId: await seedProfile(CARRIER, "vehicle_manage", true),
    })
  ).token;
  tokens.otherAdmin = (await seedUser("Outro", "BUSINESS_ADMIN", OTHER)).token;
  tokens.master = (await seedUser("Master", "MASTER", null)).token;

  // FLEET-AP-5: a service order whose bills will pass its total.
  ids.serviceOrder = (
    await prisma.serviceOrder.create({
      data: {
        maintenance_type: "EXTERNAL",
        total_amount: 500,
        businessId: CARRIER,
        vehicleId: ids.vehicle,
        responsibleUserId: ids.admin,
        branchId: ids.branch,
      },
    })
  ).id;

  todayStart = businessDayRange(new Date(), SP).start;
  const DAY = 86_400_000;

  const seed = (
    document_number: string,
    due: Date,
    extra: Record<string, unknown> = {},
    minutesAgo = 0,
  ) =>
    prisma.accountPayable.create({
      data: {
        document_number,
        due_date: due,
        amount: 100,
        category: "MAINTENANCE",
        businessId: CARRIER,
        branchId: ids.branch,
        registrationUserId: ids.clerk,
        payee_name: "Favorecido",
        created_at: new Date(Date.now() - minutesAgo * 60_000),
        ...extra,
      },
    });

  // OPEN: due today (the edge) and later.
  await seed("B-EDGE-2", todayStart, {}, 120);
  for (let index = 0; index < 5; index += 1) {
    await seed(
      `B-OPEN-${index}`,
      new Date(todayStart.getTime() + (index + 1) * DAY),
      {},
      110 - index,
    );
  }

  // OVERDUE: the edge, and a partially paid one.
  await seed("B-EDGE-1", new Date(todayStart.getTime() - 1), {}, 100);
  await seed(
    "B-PARTIAL-LATE",
    new Date(todayStart.getTime() - 5 * DAY),
    { amount_paid: 40, payment_date: new Date(todayStart.getTime() - 6 * DAY) },
    99,
  );

  // PAID: on the due day at 23:00 local (on time) and a day later (late).
  const dueLastWeek = new Date(todayStart.getTime() - 7 * DAY);
  await seed(
    "B-PAID-ONTIME",
    dueLastWeek,
    {
      amount_paid: 100,
      payment_date: new Date(dueLastWeek.getTime() + 23 * 3_600_000),
      category: "FUEL",
    },
    98,
  );
  await seed(
    "B-PAID-LATE",
    dueLastWeek,
    {
      amount_paid: 100,
      payment_date: new Date(dueLastWeek.getTime() + DAY),
      category: "FUEL",
    },
    97,
  );

  // Responsible: the driver. Another one: the admin.
  await seed(
    "B-DRIVER",
    new Date(todayStart.getTime() + 3 * DAY),
    {
      registrationUserId: ids.driverUser,
    },
    96,
  );
  await seed(
    "B-ADMIN",
    new Date(todayStart.getTime() + 3 * DAY),
    {
      registrationUserId: ids.admin,
    },
    95,
  );

  // Another company's bill, due long ago, with a document to look for.
  const otherUser = await prisma.user.findFirstOrThrow({
    where: { businessId: OTHER },
  });
  await prisma.accountPayable.create({
    data: {
      document_number: "B-FOREIGN",
      due_date: new Date(todayStart.getTime() - 30 * DAY),
      amount: 999,
      category: "MAINTENANCE",
      businessId: OTHER,
      branchId: ids.otherBranch,
      registrationUserId: otherUser.id,
      payee_name: "Alheio",
    },
  });

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

describe("the status is the server's, by the company's business day", () => {
  it("calls a bill due today open and one due before today overdue", async () => {
    const { status, rows } = await list("search=B-EDGE");

    expect(status).toBe(200);

    const byDoc = Object.fromEntries(
      rows.map((row) => [row.document_number, row]),
    );

    // The web's old rule marked B-EDGE-2 "Vencido" all day long.
    expect(byDoc["B-EDGE-2"]).toMatchObject({
      status: "PENDING",
      status_group: "OPEN",
    });
    expect(byDoc["B-EDGE-1"]).toMatchObject({
      status: "OVERDUE",
      status_group: "OVERDUE",
    });
  });

  it("filters in SQL exactly where the row's status puts the line", async () => {
    const overdue = await list("status=OVERDUE&search=B-EDGE");
    const open = await list("status=OPEN&search=B-EDGE");

    expect(docs(overdue.rows)).toEqual(["B-EDGE-1"]);
    expect(docs(open.rows)).toEqual(["B-EDGE-2"]);
  });

  it("tells paid on time from paid late by days, not by hours", async () => {
    const { rows } = await list("status=PAID");

    const byDoc = Object.fromEntries(
      rows.map((row) => [row.document_number, row.status]),
    );

    expect(byDoc).toEqual({ "B-PAID-ONTIME": "PAID", "B-PAID-LATE": "LATE" });
  });
});

describe("cards, filters, order and pages over the whole company (8.8)", () => {
  it("counts the cards over every bill, each bill once", async () => {
    const { meta, rows } = await list("");

    expect(rows).toHaveLength(10);
    expect(meta.total).toBe(12);
    expect(meta.searchMeta).toMatchObject({
      total: 12,
      open: 8,
      overdue: 2,
      paid: 2,
      overdueAmount: 160,
      paidAmount: 200,
    });
  });

  it("keeps the other cards whole when a situation is picked", async () => {
    const { meta, rows } = await list("status=OVERDUE");

    expect(meta.total).toBe(2);
    expect(rows).toHaveLength(2);
    expect(meta.searchMeta.open).toBe(8);
    expect(meta.searchMeta.facets.status).toEqual([
      { value: "OPEN", count: 8 },
      { value: "OVERDUE", count: 2 },
      { value: "PAID", count: 2 },
    ]);
  });

  it("filters by category and combines with the situation", async () => {
    const fuel = await list("category=FUEL");
    const fuelOverdue = await list("category=FUEL&status=OVERDUE");

    expect(fuel.meta.total).toBe(2);
    expect(fuelOverdue.meta.total).toBe(0);
    expect(fuelOverdue.meta.searchMeta.paid).toBe(2);
  });

  it("orders on the server across pages, by due date", async () => {
    const first = await ndjson(
      "/account-payable/list-account-payable?page=1&pageSize=10&sort=due_date&order=asc",
      tokens.admin,
    );
    const second = await ndjson(
      "/account-payable/list-account-payable?page=2&pageSize=10&sort=due_date&order=asc",
      tokens.admin,
    );

    const days = [...first.rows, ...second.rows].map((row) => row.due_day);

    expect(days).toHaveLength(12);
    expect([...days].sort()).toEqual(days);
  });

  it("refuses an unknown sort key or situation with a 400", async () => {
    expect((await list("sort=status")).status).toBe(400);
    expect((await list("status=LATE")).status).toBe(400);
  });
});

describe("who reads the company's list", () => {
  it("lets a read-only profile read", async () => {
    expect((await list("", tokens.readOnly)).status).toBe(200);
  });

  it("refuses a profile without the permission, and the driver", async () => {
    const noPermission = await list("", tokens.noPayables);
    const driver = await list("", tokens.driver);

    expect(noPermission.status).toBe(403);
    expect(JSON.parse(noPermission.body).code).toBe("PERMISSION_DENIED");
    expect(driver.status).toBe(403);
  });

  it("never lists or counts another company's bills", async () => {
    const mine = await list("search=B-FOREIGN");

    expect(mine.meta.total).toBe(0);
    expect((await list(`businessId=${OTHER}`)).status).toBe(403);
  });

  it("asks the MASTER to name the company, and lists that one", async () => {
    expect((await list("", tokens.master)).status).toBe(400);

    const other = await list(`businessId=${OTHER}`, tokens.master);

    expect(other.status).toBe(200);
    expect(docs(other.rows)).toEqual(["B-FOREIGN"]);
  });
});

describe("'minhas contas a pagar' is self-scoped (AP-DRV-1, decision 4.5)", () => {
  const mine = (token: string, query = "") =>
    ndjson(
      `/account-payable/search-account-payable-by-responsible-user?limit=10${query}`,
      token,
    );

  it("gives the driver who is the responsible their bills — it was a 403", async () => {
    const { status, rows } = await mine(tokens.driver);

    expect(status).toBe(200);
    expect(docs(rows)).toEqual(["B-DRIVER"]);
    expect(rows[0]).toMatchObject({
      status: "PENDING",
      registrationUserId: ids.driverUser,
    });
  });

  it("works without the profile permission and never shows someone else's bills", async () => {
    const { status, rows } = await mine(tokens.noPayables);

    expect(status).toBe(200);
    expect(rows).toEqual([]);
  });

  it("filters by the typed term on the server", async () => {
    const admin = await mine(tokens.admin, "&search=b-admin");

    expect(docs(admin.rows)).toEqual(["B-ADMIN"]);
  });
});

describe("creating a bill (decision 8.4)", () => {
  const post = (
    body: Record<string, unknown>,
    token = tokens.admin,
    business = CARRIER,
  ) =>
    app.inject({
      method: "POST",
      url: `/account-payable/create-account-payable/${business}`,
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    });

  const body = (extra: Record<string, unknown> = {}) => ({
    category: "MAINTENANCE",
    due_date: "2026-10-01",
    amount: 750.5,
    branchId: ids.branch,
    registrationUserId: ids.clerk,
    supplierId: ids.supplier,
    vehicleId: ids.vehicle,
    description: "Revisão dos freios\n\nPastilhas e discos",
    document_number: "NF 88",
    ...extra,
  });

  it("stores payee, cost centre, text fields and the session user as creator", async () => {
    const response = await post(body());

    expect(response.statusCode).toBe(201);

    const created = await prisma.accountPayable.findUniqueOrThrow({
      where: { id: response.json().id },
    });

    expect(created).toMatchObject({
      supplierId: ids.supplier,
      payee_name: null,
      vehicleId: ids.vehicle,
      description: "Revisão dos freios\n\nPastilhas e discos",
      document_number: "NF 88",
      createdById: ids.admin,
      registrationUserId: ids.clerk,
    });
    // The picked day, as the instant it starts in São Paulo.
    expect(created.due_date.toISOString()).toBe("2026-10-01T03:00:00.000Z");
  });

  it("requires a payee, and only one", async () => {
    const none = await post(body({ supplierId: null, payee_name: "" }));
    const both = await post(body({ payee_name: "Pedágio" }));

    expect(none.statusCode).toBe(400);
    expect(both.statusCode).toBe(400);
  });

  it("refuses another company's supplier or vehicle without naming it", async () => {
    const supplier = await post(body({ supplierId: ids.otherSupplier }));
    const vehicle = await post(body({ vehicleId: ids.otherVehicle }));

    expect(supplier.statusCode).toBe(400);
    expect(supplier.json()).toMatchObject({
      code: "ACCOUNT_PAYABLE_INVALID_REFERENCE",
      message: "Fornecedor não encontrado nesta empresa.",
    });
    expect(vehicle.json().message).toBe(
      "Veículo não encontrado nesta empresa.",
    );
  });
});

describe("editing and deleting", () => {
  let billId: string;

  beforeAll(async () => {
    billId = (
      await prisma.accountPayable.create({
        data: {
          document_number: "B-EDIT",
          due_date: new Date(todayStart.getTime() + 86_400_000),
          amount: 300,
          category: "TOLLS",
          businessId: CARRIER,
          branchId: ids.branch,
          registrationUserId: ids.clerk,
          payee_name: "Pedágio",
        },
      })
    ).id;
  });

  const patch = (
    payload: Record<string, unknown>,
    token: string,
    business = CARRIER,
  ) =>
    app.inject({
      method: "PATCH",
      url: `/account-payable/update-account-payable/${billId}/business/${business}`,
      headers: { authorization: `Bearer ${token}` },
      payload,
    });

  it("never moves a bill to another company, not even for the MASTER", async () => {
    const response = await patch({ amount: 320 }, tokens.master, OTHER);

    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("ACCOUNT_PAYABLE_TENANT_MISMATCH");

    const row = await prisma.accountPayable.findUniqueOrThrow({
      where: { id: billId },
    });

    expect(row.businessId).toBe(CARRIER);
    expect(Number(row.amount)).toBe(300);
  });

  it("keeps the responsible when the edit does not name one", async () => {
    const response = await patch({ document_number: "B-EDIT-2" }, tokens.admin);

    expect(response.statusCode).toBe(200);

    const row = await prisma.accountPayable.findUniqueOrThrow({
      where: { id: billId },
    });

    expect(row.registrationUserId).toBe(ids.clerk);
    expect(row.document_number).toBe("B-EDIT-2");
  });

  it("answers a paid bill's deletion with 409", async () => {
    const paid = await prisma.accountPayable.findFirstOrThrow({
      where: { document_number: "B-PAID-LATE" },
    });

    const response = await app.inject({
      method: "DELETE",
      url: `/account-payable/delete-account-payable/${paid.id}/business/${CARRIER}`,
      headers: { authorization: `Bearer ${tokens.admin}` },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("ACCOUNT_PAYABLE_ALREADY_PAID");
  });
});

describe("the export reads the list's filter (decision 5.8)", () => {
  it("writes only the rows of the situation picked, with the server's status", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/account-payable/export-account-payable?format=csv&status=PAID",
      headers: { authorization: `Bearer ${tokens.admin}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Situação");
    expect(response.body).toContain("B-PAID-ONTIME");
    expect(response.body).toContain("Paga com atraso");
    expect(response.body).not.toContain("B-EDGE-1");
    expect(response.body).not.toContain("B-FOREIGN");
  });

  it("exports the company the MASTER selected, and refuses without one", async () => {
    const other = await app.inject({
      method: "GET",
      url: `/account-payable/export-account-payable?format=csv&businessId=${OTHER}`,
      headers: { authorization: `Bearer ${tokens.master}` },
    });
    const none = await app.inject({
      method: "GET",
      url: "/account-payable/export-account-payable?format=csv",
      headers: { authorization: `Bearer ${tokens.master}` },
    });

    expect(other.statusCode).toBe(200);
    expect(other.body).toContain("B-FOREIGN");
    expect(none.statusCode).toBe(400);
  });

  it("refuses a read-only profile: exporting is a write", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/account-payable/export-account-payable?format=csv",
      headers: { authorization: `Bearer ${tokens.readOnly}` },
    });

    expect(response.statusCode).toBe(403);
  });
});

describe("bills above their service order's total (FLEET-AP-5)", () => {
  const post = (amount: number, document_number: string) =>
    app.inject({
      method: "POST",
      url: `/account-payable/create-account-payable/${CARRIER}`,
      headers: { authorization: `Bearer ${tokens.admin}` },
      payload: {
        category: "MAINTENANCE",
        due_date: "2026-11-10",
        amount,
        branchId: ids.branch,
        registrationUserId: ids.clerk,
        payee_name: "Oficina da OS",
        serviceOrderId: ids.serviceOrder,
        document_number,
      },
    });

  it("saves and warns in the 201 and the 200 bodies, and stops warning below the total", async () => {
    const first = await post(300, "OS-1");
    const second = await post(300, "OS-2");

    expect(first.statusCode).toBe(201);
    expect(first.json().warnings).toEqual([]);

    // 600 against an order of 500: saved, and said. The serializer keeps
    // the field only while the Swagger schema declares it.
    expect(second.statusCode).toBe(201);
    expect(second.json().warnings).toHaveLength(1);
    expect(second.json().warnings[0]).toContain("R$");

    const patch = (amount: number) =>
      app.inject({
        method: "PATCH",
        url: `/account-payable/update-account-payable/${second.json().id}/business/${CARRIER}`,
        headers: { authorization: `Bearer ${tokens.admin}` },
        payload: { amount },
      });

    const lowered = await patch(150);

    expect(lowered.statusCode).toBe(200);
    expect(lowered.json().warnings).toEqual([]);

    const raised = await patch(250.01);

    expect(raised.statusCode).toBe(200);
    expect(raised.json().warnings).toHaveLength(1);
    expect(
      await prisma.accountPayable.count({
        where: { serviceOrderId: ids.serviceOrder },
      }),
    ).toBe(2);
  });
});

describe("an edit never leaves a bill without its payee (decision 8.4)", () => {
  it("refuses clearing the payee of a bill that has one, and allows it on a legacy bill", async () => {
    const withPayee = await prisma.accountPayable.create({
      data: {
        document_number: "B-PAYEE",
        due_date: new Date(todayStart.getTime() + 86_400_000),
        amount: 90,
        category: "TOLLS",
        businessId: CARRIER,
        branchId: ids.branch,
        registrationUserId: ids.clerk,
        supplierId: ids.supplier,
      },
    });
    const legacy = await prisma.accountPayable.create({
      data: {
        document_number: "B-LEGACY",
        due_date: new Date(todayStart.getTime() + 86_400_000),
        amount: 90,
        category: "TOLLS",
        businessId: CARRIER,
        branchId: ids.branch,
        registrationUserId: ids.clerk,
      },
    });

    const patch = (id: string, payload: Record<string, unknown>) =>
      app.inject({
        method: "PATCH",
        url: `/account-payable/update-account-payable/${id}/business/${CARRIER}`,
        headers: { authorization: `Bearer ${tokens.admin}` },
        payload,
      });

    const cleared = await patch(withPayee.id, { supplierId: null });

    expect(cleared.statusCode).toBe(400);
    expect(cleared.json().code).toBe("ACCOUNT_PAYABLE_PAYEE_REQUIRED");
    expect(
      (
        await prisma.accountPayable.findUniqueOrThrow({
          where: { id: withPayee.id },
        })
      ).supplierId,
    ).toBe(ids.supplier);

    // Registering a payment on a bill from before the column needs no payee.
    const paid = await patch(legacy.id, {
      supplierId: null,
      payee_name: null,
      amount_paid: 90,
      payment_date: "2026-09-28",
    });

    expect(paid.statusCode).toBe(200);
  });
});

describe("who may write bills, and where (roles and tenants)", () => {
  let targetId: string;

  beforeAll(async () => {
    targetId = (
      await prisma.accountPayable.create({
        data: {
          document_number: "B-GUARDED",
          due_date: new Date(todayStart.getTime() + 2 * 86_400_000),
          amount: 410,
          category: "RENTAL",
          businessId: CARRIER,
          branchId: ids.branch,
          registrationUserId: ids.clerk,
          payee_name: "Locadora",
        },
      })
    ).id;
  });

  const createBody = {
    category: "OTHER",
    category_description: "Intrusão",
    due_date: "2026-10-05",
    amount: 12,
    payee_name: "Ninguém",
    document_number: "B-INTRUDER",
  };

  const unchanged = async () =>
    expect(
      await prisma.accountPayable.findUniqueOrThrow({
        where: { id: targetId },
      }),
    ).toMatchObject({ businessId: CARRIER, document_number: "B-GUARDED" });

  it.each([
    ["a read-only profile", "readOnly", "PERMISSION_DENIED"],
    ["a profile without the key", "noPayables", "PERMISSION_DENIED"],
    ["a driver", "driver", "PERMISSION_DENIED"],
    ["another company's admin", "otherAdmin", "TENANT_ACCESS_DENIED"],
  ] as const)(
    "refuses %s on create, update, delete and export",
    async (_who, token, code) => {
      const headers = { authorization: `Bearer ${tokens[token]}` };

      const create = await app.inject({
        method: "POST",
        url: `/account-payable/create-account-payable/${CARRIER}`,
        headers,
        payload: {
          ...createBody,
          branchId: ids.branch,
          registrationUserId: ids.clerk,
        },
      });
      const update = await app.inject({
        method: "PATCH",
        url: `/account-payable/update-account-payable/${targetId}/business/${CARRIER}`,
        headers,
        payload: { document_number: "B-HIJACKED" },
      });
      const remove = await app.inject({
        method: "DELETE",
        url: `/account-payable/delete-account-payable/${targetId}/business/${CARRIER}`,
        headers,
      });
      const exported = await app.inject({
        method: "GET",
        url: `/account-payable/export-account-payable?format=csv&businessId=${CARRIER}`,
        headers,
      });

      for (const response of [create, update, remove, exported]) {
        expect(response.statusCode).toBe(403);
        expect(response.json().code).toBe(code);
      }

      expect(
        await prisma.accountPayable.count({
          where: { document_number: "B-INTRUDER" },
        }),
      ).toBe(0);
      await unchanged();
    },
  );

  it("refuses another company's admin naming their own company for this bill", async () => {
    const headers = { authorization: `Bearer ${tokens.otherAdmin}` };

    const update = await app.inject({
      method: "PATCH",
      url: `/account-payable/update-account-payable/${targetId}/business/${OTHER}`,
      headers,
      payload: { document_number: "B-HIJACKED" },
    });
    const remove = await app.inject({
      method: "DELETE",
      url: `/account-payable/delete-account-payable/${targetId}/business/${OTHER}`,
      headers,
    });

    // Exactly the answer for an id that does not exist: a 403 here told the
    // other company the id is real (IDOR sweep, 10/2026).
    for (const response of [update, remove]) {
      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe("ACCOUNT_PAYABLE_NOT_FOUND");
    }

    await unchanged();
  });

  it("refuses a create naming another company's branch, as if it did not exist", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/account-payable/create-account-payable/${CARRIER}`,
      headers: { authorization: `Bearer ${tokens.admin}` },
      payload: {
        ...createBody,
        branchId: ids.otherBranch,
        registrationUserId: ids.clerk,
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe("BRANCH_NOT_FOUND");
    expect(
      await prisma.accountPayable.count({
        where: { document_number: "B-INTRUDER" },
      }),
    ).toBe(0);
  });

  it("caps the export's search like the list's", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/account-payable/export-account-payable?format=csv&search=${"a".repeat(101)}`,
      headers: { authorization: `Bearer ${tokens.admin}` },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("VALIDATION_ERROR");
  });
});

describe("a switched-off company is not operated (decision 4.1)", () => {
  it("refuses the MASTER's delete of its bill with TENANT_INACTIVE and keeps it", async () => {
    const inactiveUser = await prisma.user.create({
      data: {
        name: "Usuário da Desativada",
        email: `${randomUUID()}@exemplo.com.br`,
        password: "not-used-here",
        role: "BUSINESS_ADMIN",
        businessId: INACTIVE,
      },
    });
    const bill = await prisma.accountPayable.create({
      data: {
        document_number: "B-INACTIVE",
        due_date: new Date(todayStart.getTime() + 86_400_000),
        amount: 70,
        category: "TOLLS",
        businessId: INACTIVE,
        branchId: ids.inactiveBranch,
        registrationUserId: inactiveUser.id,
        payee_name: "Pedágio",
      },
    });

    const response = await app.inject({
      method: "DELETE",
      url: `/account-payable/delete-account-payable/${bill.id}/business/${INACTIVE}`,
      headers: { authorization: `Bearer ${tokens.master}` },
    });

    // The delete route had no company check: it answered 200.
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("TENANT_INACTIVE");
    expect(
      await prisma.accountPayable.findUnique({ where: { id: bill.id } }),
    ).not.toBeNull();
  });
});
