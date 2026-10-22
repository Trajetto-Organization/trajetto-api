import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { sign } from "jsonwebtoken";

import { randomUUID } from "node:crypto";

import auth from "@/config/auth";
import { businessDateKey } from "@/shared/time/business-day";
import { fineResponses } from "@/routes/documentation/fine-documentation";

/**
 * Fines over real HTTP and Postgres (CRIT-17: they had only been reviewed on
 * the delete path).
 *
 * - The list on the server-side table contract: order, the payment status
 *   filter, branch and code facets and the cards answered for the whole
 *   company, never for the ten rows of a page (decision 8.8).
 * - The export with the list's own filters, for the company the MASTER
 *   names (decision 5.8).
 * - The writes: what the create used to drop (origin, location audit), what
 *   the edit used to accept from the client (the audit fields), and the
 *   answers that told one company about another's records.
 * - The code picker searched on the server.
 * - Walls: another company's rows, ids and names never cross; read-only,
 *   no-permission, driver and no-FLEET tokens get what their access says.
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

// Random ids: the session and entitlement caches live in the shared Redis.
const A = randomUUID();
const B = randomUUID();
const NO_FLEET = randomUUID();

const ids = {
  branchCentro: "",
  branchNorte: "",
  branchB: "",
  driverZeca: "",
  driverAna: "",
  driverB: "",
  vehicle1: "",
  vehicle2: "",
  vehicleB: "",
  codeSpeed: "",
  codeParking: "",
  codeNoPoints: "",
  fineB: "",
};

const tokens = {} as Record<
  "admin" | "readOnly" | "noFines" | "driver" | "adminB" | "master" | "noFleet",
  string
>;

let adminId = "";

let cnpjSeq = 0;

function cnpj(): string {
  cnpjSeq += 1;

  return String(
    41222555000100 + cnpjSeq + Math.floor(Math.random() * 1e6) * 100,
  );
}

async function seedBusiness(
  id: string,
  modules: Array<"FLEET" | "DELIVERIES">,
) {
  await prisma.business.create({
    data: {
      id,
      corporate_reason: `Transportadora ${id.slice(0, 6)}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua das Transportadoras",
      address_number: "1",
      cnpj: cnpj(),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `${id}@exemplo.com.br`,
    },
  });

  await prisma.businessEntitlement.createMany({
    data: modules.map((module) => ({ businessId: id, module, enabled: true })),
  });
}

async function seedBranch(businessId: string, name: string): Promise<string> {
  const branch = await prisma.branch.create({
    data: {
      corporate_reason: name,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: cnpj(),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `${randomUUID()}@exemplo.com.br`,
      businessId,
    },
  });

  return branch.id;
}

async function seedDriver(businessId: string, name: string): Promise<string> {
  const suffix = randomUUID().slice(0, 8);

  const driver = await prisma.driver.create({
    data: {
      name,
      birth_date: new Date("1990-01-01"),
      cnh: `cnh-${suffix}`,
      cpf: `cpf-${suffix}`,
      rg: `rg-${suffix}`,
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

async function seedVehicle(businessId: string, plate: string): Promise<string> {
  const fuelType = await prisma.fuelType.create({
    data: { description: `Diesel ${randomUUID().slice(0, 4)}`, businessId },
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
      renavam: `rnv-${randomUUID().slice(0, 8)}`,
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
  role: "MASTER" | "BUSINESS_ADMIN" | "BUSINESS_USER",
  businessId: string | null,
  extra: { profileAccessId?: string; driverId?: string } = {},
): Promise<{ id: string; token: string }> {
  const id = randomUUID();
  const familyId = randomUUID();

  await prisma.user.create({
    data: {
      id,
      name: `Usuário ${id.slice(0, 6)}`,
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
      {
        subject: id,
        expiresIn: "15m",
      },
    ),
  };
}

const DAY = 24 * 60 * 60 * 1000;

interface FineLine {
  id: string;
  status: "PAID" | "PENDING" | "OVERDUE";
  amount: number;
  driver: { name: string };
  branch: { corporate_reason: string };
  vehicle: { license_plate: string };
  trafficViolationCode: { code: string; sub_code: number };
}

interface FineMeta {
  total: number;
  searchMeta: {
    total: number;
    paid: number;
    pending: number;
    overdue: number;
    totalAmount: number;
    openAmount: number;
    facets: Record<
      string,
      Array<{ value: string; label?: string; count: number }>
    >;
  };
}

async function list(
  query: string,
  token = tokens.admin,
): Promise<{ status: number; meta: FineMeta; rows: FineLine[]; body: string }> {
  const response = await app.inject({
    method: "GET",
    url: `/fines/list-fine?page=1&pageSize=10${query ? `&${query}` : ""}`,
    headers: { authorization: `Bearer ${token}` },
  });

  if (response.statusCode !== 200) {
    return {
      status: response.statusCode,
      meta: {} as FineMeta,
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

const amounts = (rows: FineLine[]) => rows.map((row) => row.amount);

/**
 * Twelve fines of company A, more than a page of ten. By index modulo 3:
 * 0 paid, 1 overdue (due ten days ago), 2 pending (due in twenty days).
 * Even indexes at Filial Centro with the speed code and Zeca; odd ones at
 * Filial Norte with the parking code and Ana. Amounts 100, 110, … 210, the
 * newest (index 11) created last.
 */
const SEED = Array.from({ length: 12 }, (_, index) => ({
  index,
  amount: 100 + index * 10,
  status: (["PAID", "OVERDUE", "PENDING"] as const)[index % 3],
  even: index % 2 === 0,
}));

beforeAll(async () => {
  await seedBusiness(A, ["FLEET", "DELIVERIES"]);
  await seedBusiness(B, ["FLEET"]);
  await seedBusiness(NO_FLEET, ["DELIVERIES"]);

  ids.branchCentro = await seedBranch(A, "Filial Centro");
  ids.branchNorte = await seedBranch(A, "Filial Norte");
  ids.branchB = await seedBranch(B, "Filial Secreta da B");

  ids.driverZeca = await seedDriver(A, "Zeca Alves");
  ids.driverAna = await seedDriver(A, "Ana Borges");
  ids.driverB = await seedDriver(B, "Motorista da B");

  ids.vehicle1 = await seedVehicle(A, "FNE1A01");
  ids.vehicle2 = await seedVehicle(A, "FNE2A02");
  ids.vehicleB = await seedVehicle(B, "BBB9B99");

  const code = (data: {
    code: string;
    sub_code: number;
    description: string;
    points: number;
    gravity: "LIGHT" | "MEDIUM" | "SERIOUS" | "VERY_SERIOUS" | "NO_POINTS";
  }) =>
    prisma.trafficViolationCode.create({
      data: {
        ...data,
        legal_basis: "CTB",
        violator_type: "Condutor",
        gravity_raw: data.gravity,
        competent_agency: "Estadual",
      },
    });

  ids.codeSpeed = (
    await code({
      code: "7455",
      sub_code: 0,
      description:
        "Transitar em velocidade superior à máxima permitida em até 20%",
      points: 4,
      gravity: "MEDIUM",
    })
  ).id;

  ids.codeParking = (
    await code({
      code: "5185",
      sub_code: 1,
      description: "Estacionar em local proibido pela sinalização",
      points: 3,
      gravity: "LIGHT",
    })
  ).id;

  ids.codeNoPoints = (
    await code({
      code: "5010",
      sub_code: 2,
      description: "Infração do proprietário sem pontuação",
      points: 0,
      gravity: "NO_POINTS",
    })
  ).id;

  // Filler codes before the searched ones, so a picker that ignored the term
  // would not find them on its first page.
  for (let index = 0; index < 12; index += 1) {
    await code({
      code: String(1000 + index),
      sub_code: 0,
      description: `Infração de preenchimento ${index}`,
      points: 3,
      gravity: "LIGHT",
    });
  }

  const admin = await seedUser("BUSINESS_ADMIN", A);
  adminId = admin.id;
  tokens.admin = admin.token;

  tokens.readOnly = (
    await seedUser("BUSINESS_USER", A, {
      profileAccessId: await seedProfile(A, "fine_manage", false),
    })
  ).token;

  tokens.noFines = (
    await seedUser("BUSINESS_USER", A, {
      profileAccessId: await seedProfile(A, "vehicle_manage", true),
    })
  ).token;

  tokens.driver = (
    await seedUser("BUSINESS_USER", A, { driverId: ids.driverZeca })
  ).token;

  tokens.adminB = (await seedUser("BUSINESS_ADMIN", B)).token;
  tokens.master = (await seedUser("MASTER", null)).token;
  tokens.noFleet = (await seedUser("BUSINESS_ADMIN", NO_FLEET)).token;

  const now = Date.now();

  for (const entry of SEED) {
    await prisma.fine.create({
      data: {
        businessId: A,
        branchId: entry.even ? ids.branchCentro : ids.branchNorte,
        driverId: entry.even ? ids.driverZeca : ids.driverAna,
        vehicleId: entry.even ? ids.vehicle1 : ids.vehicle2,
        trafficViolationCodeId: entry.even ? ids.codeSpeed : ids.codeParking,
        violation_date: new Date(now - 40 * DAY),
        due_date:
          entry.status === "OVERDUE"
            ? new Date(now - 10 * DAY)
            : new Date(now + 20 * DAY),
        payment_date: entry.status === "PAID" ? new Date(now - 20 * DAY) : null,
        amount: entry.amount,
        points: 4,
        created_at: new Date(now - (12 - entry.index) * 60_000),
      },
    });
  }

  ids.fineB = (
    await prisma.fine.create({
      data: {
        businessId: B,
        branchId: ids.branchB,
        driverId: ids.driverB,
        vehicleId: ids.vehicleB,
        trafficViolationCodeId: ids.codeSpeed,
        violation_date: new Date(now - 5 * DAY),
        due_date: new Date(now - 1 * DAY),
        amount: 999,
        points: 4,
      },
    })
  ).id;

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

describe("GET /fines/list-fine — order and paging", () => {
  it("defaults to newest first over the whole company, with the status of each row", async () => {
    const { status, meta, rows } = await list("");

    expect(status).toBe(200);
    expect(meta.total).toBe(12);
    expect(amounts(rows)).toEqual([
      210, 200, 190, 180, 170, 160, 150, 140, 130, 120,
    ]);
    expect(rows.map((row) => row.status).slice(0, 3)).toEqual([
      "PENDING",
      "OVERDUE",
      "PAID",
    ]);
  });

  it("sorts by amount across pages, both ways", async () => {
    const asc = await list("sort=amount&order=asc");
    const page2 = await app.inject({
      method: "GET",
      url: "/fines/list-fine?page=2&pageSize=10&sort=amount&order=asc",
      headers: { authorization: `Bearer ${tokens.admin}` },
    });

    const second = page2.body
      .trim()
      .split("\n")
      .slice(1)
      .map((line) => JSON.parse(line) as FineLine);

    expect(amounts(asc.rows)).toEqual([
      100, 110, 120, 130, 140, 150, 160, 170, 180, 190,
    ]);
    expect(amounts(second)).toEqual([200, 210]);

    const desc = await list("sort=amount&order=desc");
    expect(amounts(desc.rows)[0]).toBe(210);
  });

  it("breaks ties with the newest first", async () => {
    const { rows } = await list("sort=driverName&order=asc");

    // Ana (odd indexes) first, newest of hers first.
    expect(rows.slice(0, 6).map((row) => row.driver.name)).toEqual(
      Array(6).fill("Ana Borges"),
    );
    expect(amounts(rows).slice(0, 6)).toEqual([210, 190, 170, 150, 130, 110]);
  });

  it("streams each row as the documented row, its dates as the company's days", async () => {
    const { rows } = await list("");

    expect(rows).toHaveLength(10);

    for (const row of rows) {
      const parsed = fineResponses.fineRow.parse(row);

      expect(parsed.violation_day).toBe(
        businessDateKey(new Date(parsed.violation_date), "America/Sao_Paulo"),
      );
      expect(parsed.due_day).toBe(
        businessDateKey(new Date(parsed.due_date), "America/Sao_Paulo"),
      );
      expect(parsed.payment_day).toBe(
        parsed.payment_date
          ? businessDateKey(new Date(parsed.payment_date), "America/Sao_Paulo")
          : null,
      );
    }
  });

  it("refuses a column the API cannot order by", async () => {
    const { status, body } = await list("sort=observation");

    expect(status).toBe(400);
    expect(body).toContain("Ordenação inválida");
  });
});

describe("GET /fines/list-fine — filters and cards", () => {
  it("counts the cards over the company, not over the page", async () => {
    const { meta } = await list("");

    expect(meta.searchMeta).toMatchObject({
      total: 12,
      paid: 4,
      overdue: 4,
      pending: 4,
      totalAmount: 1860,
    });
  });

  it("filters by status and keeps the cards whole (disjunctive rule)", async () => {
    const { meta, rows } = await list("status=OVERDUE");

    expect(meta.total).toBe(4);
    expect(rows.every((row) => row.status === "OVERDUE")).toBe(true);
    expect(meta.searchMeta.paid).toBe(4);
    expect(meta.searchMeta.pending).toBe(4);
  });

  it("takes several values, comma-separated or repeated", async () => {
    const comma = await list("status=PAID,PENDING");
    const repeated = await list("status=PAID&status=PENDING");

    expect(comma.meta.total).toBe(8);
    expect(repeated.meta.total).toBe(8);
  });

  it("filters by branch, with the branch options counted without it", async () => {
    const { meta, rows } = await list(`branchId=${ids.branchNorte}`);

    expect(meta.total).toBe(6);
    expect(
      rows.every((row) => row.branch.corporate_reason === "Filial Norte"),
    ).toBe(true);
    expect(meta.searchMeta.facets.branchId).toEqual([
      { value: ids.branchCentro, label: "Filial Centro", count: 6 },
      { value: ids.branchNorte, label: "Filial Norte", count: 6 },
    ]);
  });

  it("names the codes in their filter as printed on the notice", async () => {
    const { meta } = await list("");

    expect(meta.searchMeta.facets.trafficViolationCodeId).toContainEqual({
      value: ids.codeSpeed,
      label: "7455-0",
      count: 6,
    });
  });

  it("refuses an unknown status and a malformed id", async () => {
    expect((await list("status=CANCELLED")).status).toBe(400);
    expect((await list("branchId=nao-e-uuid")).status).toBe(400);
  });

  it("searches driver, plate, printed code and amount", async () => {
    expect((await list("search=zeca")).meta.total).toBe(6);
    expect((await list("search=FNE2A02")).meta.total).toBe(6);
    expect((await list("search=5185-1")).meta.total).toBe(6);

    // With the cents: a bare "130" could also be part of a random id.
    const byAmount = await list("search=130,00");
    expect(amounts(byAmount.rows)).toEqual([130]);

    // Search and filter together.
    expect((await list("search=zeca&status=PAID")).meta.total).toBe(2);
  });
});

describe("GET /fines/list-fine — walls", () => {
  it("never shows another company's fine, nor names its branch", async () => {
    const { rows, meta, body } = await list(`branchId=${ids.branchB}`);

    expect(rows).toEqual([]);
    expect(
      meta.searchMeta.facets.branchId.map((option) => option.value),
    ).not.toContain(ids.branchB);
    expect(body).not.toContain("Filial Secreta da B");
    expect((await list("search=Secreta")).rows).toEqual([]);
  });

  it("refuses another company's manager who names this company", async () => {
    const { status } = await list(`businessId=${A}`, tokens.adminB);

    expect(status).toBe(403);
  });

  it("lets the MASTER read the company he names, and only with a name", async () => {
    const named = await list(`businessId=${A}`, tokens.master);
    expect(named.status).toBe(200);
    expect(named.meta.total).toBe(12);

    const unnamed = await list("", tokens.master);
    expect(unnamed.status).toBe(400);
    expect(unnamed.body).toContain("BUSINESS_NOT_IDENTIFIED");
  });

  it("answers each profile what its access says", async () => {
    expect((await list("", tokens.readOnly)).status).toBe(200);

    const noFines = await list("", tokens.noFines);
    expect(noFines.status).toBe(403);
    expect(noFines.body).toContain("PERMISSION_DENIED");

    const driver = await list("", tokens.driver);
    expect(driver.status).toBe(403);
    expect(driver.body).toContain("PERMISSION_DENIED");

    const noFleet = await list("", tokens.noFleet);
    expect(noFleet.status).toBe(403);
    expect(noFleet.body).toContain("MODULE_NOT_ENABLED");
  });
});

describe("GET /fines/export-fine", () => {
  async function exportFines(query: string, token = tokens.admin) {
    return app.inject({
      method: "GET",
      url: `/fines/export-fine?format=csv${query ? `&${query}` : ""}`,
      headers: { authorization: `Bearer ${token}` },
    });
  }

  it("exports what the list shows, for the company the MASTER names", async () => {
    const response = await exportFines(
      `businessId=${A}&status=OVERDUE`,
      tokens.master,
    );

    expect(response.statusCode).toBe(200);

    const lines = response.body.replace(/^﻿/, "").trim().split("\n");

    // Header plus the four overdue fines; nothing of company B.
    expect(lines).toHaveLength(5);
    expect(response.body).not.toContain(ids.fineB);
    expect(response.body).toContain("Vencida");
  });

  it("dates the file with the company's business day", async () => {
    const response = await exportFines("");

    expect(response.headers["content-disposition"]).toContain(
      `relatorio-multas-${businessDateKey(new Date(), "America/Sao_Paulo")}.csv`,
    );
  });

  it("says there is nothing to export under the current filters", async () => {
    const response = await exportFines("search=nada-bate-com-isto");

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("NO_FINES_TO_EXPORT");
  });

  it("wants the MASTER to name the company, and is a write for others", async () => {
    expect((await exportFines("", tokens.master)).statusCode).toBe(400);
    expect((await exportFines("", tokens.readOnly)).statusCode).toBe(403);
  });
});

describe("POST /fines/create-fine/:businessId", () => {
  const body = (overrides: Record<string, unknown> = {}) => ({
    violation_date: new Date(Date.now() - 3 * DAY).toISOString(),
    due_date: new Date(Date.now() + 27 * DAY).toISOString(),
    amount: "293,47",
    points: "4",
    branchId: ids.branchCentro,
    driverId: ids.driverZeca,
    vehicleId: ids.vehicle1,
    trafficViolationCodeId: ids.codeSpeed,
    created_from: "WEB_DASHBOARD",
    ...overrides,
  });

  async function create(
    payload: Record<string, unknown>,
    token = tokens.admin,
  ) {
    return app.inject({
      method: "POST",
      url: `/fines/create-fine/${A}`,
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
  }

  it("keeps the origin and signs a point placed on the web map", async () => {
    const response = await create(
      body({
        observation: "radar-map-signature",
        latitude: "-23.55",
        longitude: "-46.63",
      }),
    );

    expect(response.statusCode).toBe(201);

    const fine = await prisma.fine.findFirstOrThrow({
      where: { observation: "radar-map-signature" },
    });

    expect(fine.created_from).toBe("WEB_DASHBOARD");
    expect(fine.location_source).toBe("USER_MANUAL");
    expect(fine.location_edited_by).toBe(adminId);
  });

  it("accepts an address as the notice prints it and a multiline observation", async () => {
    const response = await create(
      body({
        location: "Av. Brasil, 1000 - Centro/SP",
        observation: "Radar móvel.\nNotificação recebida pelos Correios.",
      }),
    );

    expect(response.statusCode).toBe(201);
  });

  it("keeps zero points for an infraction without points", async () => {
    const response = await create(
      body({
        points: "0",
        trafficViolationCodeId: ids.codeNoPoints,
        observation: "zero-points",
      }),
    );

    expect(response.statusCode).toBe(201);
    expect(
      (
        await prisma.fine.findFirstOrThrow({
          where: { observation: "zero-points" },
        })
      ).points,
    ).toBe(0);
  });

  it("answers another company's driver exactly like an unknown one", async () => {
    const foreign = await create(body({ driverId: ids.driverB }));
    const unknown = await create(body({ driverId: randomUUID() }));

    expect(foreign.statusCode).toBe(400);
    expect(foreign.json()).toEqual(unknown.json());
    expect(foreign.json().code).toBe("DRIVER_NOT_FOUND");
  });

  it("refuses a payment dated in the future", async () => {
    const response = await create(
      body({ payment_date: new Date(Date.now() + 2 * DAY).toISOString() }),
    );

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("FINE_PAYMENT_DATE_IN_FUTURE");
  });

  it("stores the picked day as the day it starts in the company's zone", async () => {
    const zone = "America/Sao_Paulo";
    const violationDay = businessDateKey(new Date(Date.now() - 3 * DAY), zone);
    const dueDay = businessDateKey(new Date(Date.now() + 27 * DAY), zone);

    const response = await create(
      body({
        violation_date: violationDay,
        due_date: dueDay,
        payment_date: violationDay,
        observation: "picked-as-day",
      }),
    );

    expect(response.statusCode).toBe(201);

    const fine = await prisma.fine.findFirstOrThrow({
      where: { observation: "picked-as-day" },
    });

    // São Paulo's midnight (UTC-3, no daylight saving since 2019).
    expect(fine.violation_date.toISOString()).toBe(
      `${violationDay}T03:00:00.000Z`,
    );
    expect(fine.due_date.toISOString()).toBe(`${dueDay}T03:00:00.000Z`);
    expect(fine.payment_date?.toISOString()).toBe(
      `${violationDay}T03:00:00.000Z`,
    );

    const { rows } = await list(`search=${fine.id}`);

    expect(rows[0]).toMatchObject({
      id: fine.id,
      violation_day: violationDay,
      due_day: dueDay,
      payment_day: violationDay,
      status: "PAID",
    });
  });

  it("refuses a day that does not exist", async () => {
    const response = await create(body({ due_date: "2027-02-30" }));

    expect(response.statusCode).toBe(400);
  });

  it("takes the code's points when the request has none", async () => {
    const { points: _points, ...withoutPoints } = body({
      observation: "code-points",
    });

    const response = await create(withoutPoints);

    expect(response.statusCode).toBe(201);
    expect(
      (
        await prisma.fine.findFirstOrThrow({
          where: { observation: "code-points" },
        })
      ).points,
    ).toBe(4);
  });

  it("answers another company's branch exactly like an unknown one", async () => {
    const foreign = await create(body({ branchId: ids.branchB }));
    const unknown = await create(body({ branchId: randomUUID() }));

    expect(foreign.statusCode).toBe(404);
    expect(foreign.json()).toEqual(unknown.json());
    expect(foreign.json().code).toBe("BRANCH_NOT_FOUND");
  });

  it("refuses another company's manager, a read-only profile and a driver", async () => {
    const before = await prisma.fine.count({ where: { businessId: A } });

    const foreign = await create(
      body({ observation: "cross-tenant" }),
      tokens.adminB,
    );
    const readOnly = await create(
      body({ observation: "cross-tenant" }),
      tokens.readOnly,
    );
    const driver = await create(
      body({ observation: "cross-tenant" }),
      tokens.driver,
    );
    const noFleet = await app.inject({
      method: "POST",
      url: `/fines/create-fine/${NO_FLEET}`,
      headers: { authorization: `Bearer ${tokens.noFleet}` },
      payload: body({ observation: "cross-tenant" }),
    });

    expect(foreign.statusCode).toBe(403);
    expect(readOnly.statusCode).toBe(403);
    expect(readOnly.json().code).toBe("PERMISSION_DENIED");
    expect(driver.statusCode).toBe(403);
    expect(noFleet.statusCode).toBe(403);
    expect(noFleet.json().code).toBe("MODULE_NOT_ENABLED");
    expect(await prisma.fine.count({ where: { businessId: A } })).toBe(before);
  });
});

describe("PATCH /fines/update-fine/:fineId/business/:businessId", () => {
  async function seedOwnFine(overrides: Record<string, unknown> = {}) {
    return prisma.fine.create({
      data: {
        businessId: A,
        branchId: ids.branchCentro,
        driverId: ids.driverZeca,
        vehicleId: ids.vehicle1,
        trafficViolationCodeId: ids.codeSpeed,
        violation_date: new Date(Date.now() - 30 * DAY),
        due_date: new Date(Date.now() + 5 * DAY),
        amount: 50,
        points: 4,
        ...overrides,
      },
    });
  }

  async function patch(
    fineId: string,
    businessId: string,
    payload: Record<string, unknown>,
    token = tokens.admin,
  ) {
    return app.inject({
      method: "PATCH",
      url: `/fines/update-fine/${fineId}/business/${businessId}`,
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
  }

  it("answers another company's fine like one that does not exist", async () => {
    const foreign = await patch(ids.fineB, A, { amount: "1" });
    const unknown = await patch(randomUUID(), A, { amount: "1" });

    expect(foreign.statusCode).toBe(404);
    expect(foreign.json()).toEqual(unknown.json());
    expect(foreign.json().code).toBe("FINE_NOT_FOUND");
    expect(
      Number(
        (await prisma.fine.findUniqueOrThrow({ where: { id: ids.fineB } }))
          .amount,
      ),
    ).toBe(999);
  });

  it("never takes the location audit from the request", async () => {
    const fine = await seedOwnFine();

    // The edit schema used to accept these, so an edit that did not move
    // the point could sign it with anybody's id.
    const response = await patch(fine.id, A, {
      amount: "60",
      location_edited_by: randomUUID(),
      location_edited_at: new Date().toISOString(),
      location_source: "GPS_AUTO",
    });

    expect(response.statusCode).toBe(200);

    const saved = await prisma.fine.findUniqueOrThrow({
      where: { id: fine.id },
    });

    expect(Number(saved.amount)).toBe(60);
    expect(saved.location_edited_by).toBeNull();
    expect(saved.location_edited_at).toBeNull();
    expect(saved.location_source).toBeNull();
  });

  it("signs a point moved on the map with who moved it", async () => {
    const fine = await seedOwnFine();

    expect(
      (await patch(fine.id, A, { latitude: "-23.5", longitude: "-46.6" }))
        .statusCode,
    ).toBe(200);

    const saved = await prisma.fine.findUniqueOrThrow({
      where: { id: fine.id },
    });

    expect(saved.location_edited_by).toBe(adminId);
    expect(saved.location_source).toBe("USER_MANUAL");
  });

  it("undoes a payment sent empty", async () => {
    const fine = await seedOwnFine({
      payment_date: new Date(Date.now() - 2 * DAY),
    });

    expect((await patch(fine.id, A, { payment_date: "" })).statusCode).toBe(
      200,
    );
    expect(
      (await prisma.fine.findUniqueOrThrow({ where: { id: fine.id } }))
        .payment_date,
    ).toBeNull();
  });

  it("checks the dates as they will be saved", async () => {
    const fine = await seedOwnFine({
      payment_date: new Date(Date.now() - 20 * DAY),
    });

    const response = await patch(fine.id, A, {
      violation_date: new Date(Date.now() - 10 * DAY).toISOString(),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("FINE_PAYMENT_DATE_BEFORE_VIOLATION");
  });

  it("is a write: the read-only profile is refused", async () => {
    const fine = await seedOwnFine();

    expect(
      (await patch(fine.id, A, { amount: "10" }, tokens.readOnly)).statusCode,
    ).toBe(403);
  });
});

describe("GET /traffic-violation/search-traffic-violation-codes", () => {
  async function search(query: string, token = tokens.admin) {
    const response = await app.inject({
      method: "GET",
      url: `/traffic-violation/search-traffic-violation-codes?limit=10${query ? `&${query}` : ""}`,
      headers: { authorization: `Bearer ${token}` },
    });

    return {
      status: response.statusCode,
      body: response.body,
      rows:
        response.statusCode === 200
          ? response.body
              .trim()
              .split("\n")
              .slice(1)
              .map(
                (line) => JSON.parse(line) as { id: string; fullCode: string },
              )
          : [],
    };
  }

  it("searches the table on the server, beyond the first page", async () => {
    const { rows } = await search("search=estacionar");

    expect(rows.map((row) => row.id)).toEqual([ids.codeParking]);
  });

  it("finds the code as printed on the notice", async () => {
    const { rows } = await search("search=7455-0");

    expect(rows.map((row) => row.fullCode)).toEqual(["7455-0"]);
  });

  it("belongs to the fleet module and to whoever reads fines", async () => {
    const noFleet = await search("", tokens.noFleet);
    expect(noFleet.status).toBe(403);
    expect(noFleet.body).toContain("MODULE_NOT_ENABLED");

    expect((await search("", tokens.noFines)).status).toBe(403);
    expect((await search("", tokens.master)).status).toBe(200);
  });
});
