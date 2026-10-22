import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { sign } from "jsonwebtoken";

import { randomUUID } from "node:crypto";

import auth from "@/config/auth";
import { businessDaysRange } from "@/shared/time/business-day";

/**
 * The activity table and summary over real HTTP and Postgres.
 *
 * - Filters run on the server over the whole trail (FLEET-ACT-3), not over
 *   the ten rows of a page; a status finds its legacy spellings.
 * - A driver acting from the app is presented and filterable as DRIVER
 *   (FLEET-ACT-7).
 * - The MASTER's company filter applies to the table too, and a company
 *   admin never reads another company, whatever id it sends.
 * - "7 dias" are civil days in the company's zone (decision 1.1).
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018fed00-0000-7000-8000-00000000000a";
const OTHER = "018fed00-0000-7000-8000-00000000000b";

const ids: Record<
  "master" | "admin" | "collaborator" | "driver" | "otherAdmin",
  string
> = {} as never;
const tokens: typeof ids = {} as never;

let cnpjSeq = 0;

async function seedBusiness(id: string, timezone: string) {
  cnpjSeq += 1;

  await prisma.business.create({
    data: {
      id,
      corporate_reason: `Transportadora Atividades ${id.slice(-1)}`,
      cep: "69000000",
      city: "Manaus",
      uf: "AM",
      street: "Rua",
      address_number: "1",
      cnpj: String(86222555000180 + cnpjSeq),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "92999999999",
      email: `${id}@exemplo.com.br`,
      timezone,
    },
  });
}

async function seedUser(
  role: "MASTER" | "BUSINESS_ADMIN" | "BUSINESS_USER",
  businessId: string | null,
  driverId?: string,
): Promise<{ id: string; token: string }> {
  const id = randomUUID();
  const familyId = randomUUID();

  await prisma.user.create({
    data: {
      id,
      name: `Pessoa ${id.slice(0, 4)}`,
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
    { subject: id, expiresIn: "15m" },
  );

  return { id, token };
}

async function list(query: string, token = tokens.admin) {
  const response = await app.inject({
    method: "GET",
    url: `/activity/list?page=1&pageSize=10${query ? `&${query}` : ""}`,
    headers: { authorization: `Bearer ${token}` },
  });

  if (response.statusCode !== 200) {
    return {
      status: response.statusCode,
      rows: [] as any[],
      total: 0,
      body: response.body,
    };
  }

  const [first, ...rows] = response.body
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  return {
    status: 200,
    rows,
    total: first.meta.total as number,
    body: response.body,
  };
}

// The window boundary of "7 dias" in the carrier's zone (Manaus, UTC-4).
const windowStart = businessDaysRange(new Date(), "America/Manaus", 7).start;

beforeAll(async () => {
  await seedBusiness(CARRIER, "America/Manaus");
  await seedBusiness(OTHER, "America/Sao_Paulo");

  const driver = await prisma.driver.create({
    data: {
      name: "Motorista App",
      birth_date: new Date("1990-01-01"),
      cnh: "act-cnh-1",
      cpf: "act-cpf-1",
      rg: "act-rg-1",
      cep: "69000000",
      city: "Manaus",
      uf: "AM",
      street: "Rua",
      address_number: "1",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId: CARRIER,
    },
  });

  for (const [key, role, businessId, driverId] of [
    ["master", "MASTER", null, undefined],
    ["admin", "BUSINESS_ADMIN", CARRIER, undefined],
    ["collaborator", "BUSINESS_USER", CARRIER, undefined],
    ["driver", "BUSINESS_USER", CARRIER, driver.id],
    ["otherAdmin", "BUSINESS_ADMIN", OTHER, undefined],
  ] as const) {
    const seeded = await seedUser(role, businessId, driverId);

    ids[key] = seeded.id;
    tokens[key] = seeded.token;
  }

  const now = Date.now();
  const row = (
    index: number,
    fields: Partial<{
      type: string;
      action: string;
      status: string;
      performedBy: string;
      businessId: string;
      visibilityLevel: string;
      performingUserRole: string;
      created_at: Date;
    }>,
  ) => ({
    type: "Veículo",
    action: "update",
    entityId: `entity-${index}`,
    description: `Atividade ${index}`,
    status: "Atualizado",
    performedBy: ids.admin,
    businessId: CARRIER,
    created_at: new Date(now - index * 1000),
    ...fields,
  });

  await prisma.activity.createMany({
    data: [
      // Twelve by the admin: more than a page.
      ...Array.from({ length: 12 }, (_, index) => row(index, {})),
      row(20, { type: "Entrega", status: "Em rota", performedBy: ids.driver }),
      row(21, {
        type: "Veículo",
        status: "Em Rota",
        performedBy: ids.collaborator,
      }),
      row(22, {
        type: "Rota",
        status: "PLANNED",
        performedBy: ids.collaborator,
        action: "create",
      }),
      row(23, { type: "Entrega", status: "Entregue", performedBy: ids.driver }),
      // MASTER actions: hidden from the company, except its plan changing.
      row(24, {
        type: "Empresa",
        status: "Atualizado",
        performedBy: ids.master,
      }),
      row(25, {
        type: "Plano",
        status: "Ativo",
        performedBy: ids.master,
        performingUserRole: "MASTER",
        visibilityLevel: "TENANT_VISIBLE",
      }),
      // Another company.
      row(26, {
        businessId: OTHER,
        performedBy: ids.otherAdmin,
        status: "Em rota",
        type: "Entrega",
      }),
      // The window's edge in Manaus: a minute before (out), a minute after (in).
      row(27, {
        created_at: new Date(windowStart.getTime() - 60_000),
        type: "Multa",
        action: "delete",
      }),
      row(28, {
        created_at: new Date(windowStart.getTime() + 60_000),
        type: "Multa",
        action: "delete",
      }),
    ],
  });

  ({ app } = await import("@/http"));
  await app.ready();
}, 90_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

describe("GET /activity/list — filters on the server", () => {
  it("finds a status with its legacy spellings across the whole trail", async () => {
    const enRoute = await list("status=Em rota".replace(" ", "%20"));

    expect(enRoute.status).toBe(200);
    expect(enRoute.total).toBe(2);
    expect(enRoute.rows.map((row) => row.description).sort()).toEqual([
      "Atividade 20",
      "Atividade 21",
    ]);

    const planned = await list("status=Planejada");
    expect(planned.rows.map((row) => row.description)).toEqual([
      "Atividade 22",
    ]);
  });

  it("filters the author role, presenting the app's driver as DRIVER", async () => {
    const drivers = await list("role=DRIVER");

    expect(drivers.total).toBe(2);
    expect(drivers.rows.every((row) => row.user.role === "DRIVER")).toBe(true);
    expect(drivers.body).not.toContain("driverId");

    const collaborators = await list("role=BUSINESS_USER");
    expect(collaborators.rows.map((row) => row.description).sort()).toEqual([
      "Atividade 21",
      "Atividade 22",
    ]);
  });

  it("combines facets with each other and with the search", async () => {
    const combined = await list("type=Entrega,Rota&action=create");

    expect(combined.rows.map((row) => row.description)).toEqual([
      "Atividade 22",
    ]);

    const searched = await list("type=Veículo&search=Atividade%201");
    // Atividade 1, 10 and 11: the Veículo rows whose text has the term.
    expect(searched.total).toBe(3);
  });

  it("keeps the company's scope: MASTER actions hidden except its plan, other companies never", async () => {
    const all = await list("");

    // 12 + 4 + the plan change + 2 at the window edge; the MASTER's own
    // company edit and the other company's row are not there.
    expect(all.total).toBe(19);

    // Naming another company is refused by the tenant guard, not honoured.
    expect((await list(`businessId=${OTHER}`)).status).toBe(403);

    const plan = await list("role=PLATFORM");
    expect(plan.rows).toHaveLength(1);
    expect(plan.rows[0].user).toMatchObject({ role: "PLATFORM", email: null });

    // The row's own copies of the operator's identity do not reach the company.
    expect(plan.rows[0]).toMatchObject({
      performedBy: null,
      performingUserRole: null,
    });
    expect(plan.body).not.toContain(ids.master);
  });

  it("does not let a company search confirm the operator's e-mail or id", async () => {
    const email = `${ids.master}@exemplo.com.br`;

    expect((await list(`search=${encodeURIComponent(email)}`)).total).toBe(0);
    expect((await list(`search=${ids.master}`)).total).toBe(0);

    // The MASTER audits with real identities: both of its rows.
    const audit = await list(
      `businessId=${CARRIER}&search=${encodeURIComponent(email)}`,
      tokens.master,
    );

    expect(audit.total).toBe(2);
    expect(audit.rows.every((row) => row.performedBy === ids.master)).toBe(
      true,
    );
  });

  it("lets the MASTER narrow the table to one company", async () => {
    const other = await list(`businessId=${OTHER}`, tokens.master);

    expect(other.total).toBe(1);
    expect(other.rows[0].description).toBe("Atividade 26");
  });

  it("refuses a value outside the catalog and a collaborator", async () => {
    expect((await list("status=Voando")).status).toBe(400);
    expect((await list("role=ROOT")).status).toBe(400);
    expect((await list("", tokens.collaborator)).status).toBe(403);
  });
});

describe("GET /activity/summary — the period in the company's zone", () => {
  it("counts civil days in the company's zone, today included", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/activity/summary?period=7d&businessId=${CARRIER}`,
      headers: { authorization: `Bearer ${tokens.master}` },
    });

    expect(response.statusCode).toBe(200);

    const summary = response.json().data;

    // 12 + 4 + 2 MASTER rows + the one just inside the edge = 19; the one a
    // minute before the Manaus midnight six days ago is out.
    expect(summary.total).toBe(19);
    expect(summary.deleted).toBe(1);
    // Admin, collaborator, driver, master.
    expect(summary.activeUsers).toBe(4);
  });
});

describe("GET /activity/list — the DRIVER facet is the presented DRIVER", () => {
  it("files an admin linked to a driver under BUSINESS_ADMIN only", async () => {
    const THIRD = "018fed00-0000-7000-8000-00000000000c";

    await seedBusiness(THIRD, "America/Sao_Paulo");

    const [adminDriver, appDriver] = await Promise.all(
      ["3", "4"].map((suffix) =>
        prisma.driver.create({
          data: {
            name: `Motorista ${suffix}`,
            birth_date: new Date("1990-01-01"),
            cnh: `act-cnh-${suffix}`,
            cpf: `act-cpf-${suffix}`,
            rg: `act-rg-${suffix}`,
            cep: "01000000",
            city: "São Paulo",
            uf: "SP",
            street: "Rua",
            address_number: "1",
            status: "ACTIVE",
            contract_type: "OWNED",
            businessId: THIRD,
          },
        }),
      ),
    );

    const admin = await seedUser("BUSINESS_ADMIN", THIRD, adminDriver.id);
    const driverUser = await seedUser("BUSINESS_USER", THIRD, appDriver.id);

    await prisma.activity.createMany({
      data: [
        {
          type: "Veículo",
          action: "update",
          entityId: "entity-admin-driver",
          description: "Pela gestora",
          status: "Atualizado",
          performedBy: admin.id,
          businessId: THIRD,
        },
        {
          type: "Entrega",
          action: "update",
          entityId: "entity-app-driver",
          description: "Pelo app",
          status: "Entregue",
          performedBy: driverUser.id,
          businessId: THIRD,
        },
      ],
    });

    const drivers = await list(
      `businessId=${THIRD}&role=DRIVER`,
      tokens.master,
    );
    const admins = await list(
      `businessId=${THIRD}&role=BUSINESS_ADMIN`,
      tokens.master,
    );

    expect(drivers.rows.map((row) => row.description)).toEqual(["Pelo app"]);
    expect(drivers.rows[0].user.role).toBe("DRIVER");
    expect(admins.rows.map((row) => row.description)).toEqual(["Pela gestora"]);
    expect(admins.rows[0].user.role).toBe("BUSINESS_ADMIN");
  });
});

describe("ActivityRepository.createActivity — one spelling per status", () => {
  it("stores a raw route enum and a variant as the catalog's label (FLEET-ACT-1/5)", async () => {
    const { ActivityRepository } = await import(
      "@/modules/activity/repositories/activity-repository"
    );
    const repository = new ActivityRepository();

    const planned = await repository.createActivity({
      type: "Rota",
      action: "update",
      entityId: "route-raw-enum",
      description: "Rota atualizada",
      status: "PLANNED",
      performedBy: ids.admin,
      businessId: CARRIER,
    });
    const enRoute = await repository.createActivity({
      type: "Veículo",
      action: "update",
      entityId: "vehicle-variant",
      description: "Veículo em rota",
      status: "Em Rota",
      performedBy: ids.admin,
      businessId: CARRIER,
    });

    const stored = await prisma.activity.findMany({
      where: { id: { in: [planned.id, enRoute.id] } },
      select: { entityId: true, status: true },
      orderBy: { entityId: "asc" },
    });

    expect(stored).toEqual([
      { entityId: "route-raw-enum", status: "Planejada" },
      { entityId: "vehicle-variant", status: "Em rota" },
    ]);
  });
});
