import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { sign } from "jsonwebtoken";

import { randomUUID } from "node:crypto";

import auth from "@/config/auth";
import { businessDateKey } from "@/shared/time/business-day";

/**
 * The driver list as the /admin and /dashboard screens read it, over real
 * HTTP and Postgres: order, filters and cards answered by the server for the
 * whole company (decision 8.8), the export following the same filter
 * (decision 5.8), and the walls around both — another company's drivers,
 * branch names and ids never cross, and only who may read drivers reads them.
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018fe500-0000-7000-8000-00000000000a";
const OTHER = "018fe500-0000-7000-8000-00000000000b";

const NORTE = "018fe500-0000-7000-8000-0000000000b1";
const SUL = "018fe500-0000-7000-8000-0000000000b2";
const FOREIGN_BRANCH = "018fe500-0000-7000-8000-0000000000b9";

const tokens: Record<
  "admin" | "readOnly" | "dispatcher" | "driver" | "otherAdmin" | "master",
  string
> = {} as never;

let cnpjSeq = 0;

async function seedBusiness(id: string, timezone = "America/Sao_Paulo") {
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
      timezone,
    },
  });
}

async function seedBranch(id: string, businessId: string, name: string) {
  cnpjSeq += 1;

  await prisma.branch.create({
    data: {
      id,
      corporate_reason: name,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(51222555000180 + cnpjSeq),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `${id}@exemplo.com.br`,
      businessId,
    },
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
  role: "MASTER" | "BUSINESS_ADMIN" | "BUSINESS_USER",
  businessId: string | null,
  extra: { profileAccessId?: string; driverId?: string } = {},
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

  return sign(
    { tokenType: "access", sessionVersion: 0, familyId },
    auth.secret_token,
    {
      subject: id,
      expiresIn: "15m",
    },
  );
}

/**
 * Twelve drivers, more than a page of ten. By index:
 * - name "Motorista A".."Motorista L", created oldest first (L is the newest);
 * - status: INACTIVE for 0, 4, 8; ACTIVE otherwise (9 active);
 * - contract: THIRD_PARTY for 0, 3, 6, 9; OWNED otherwise;
 * - category: E for i%3=0, AB for i%3=1, none for i%3=2;
 * - expiry: 0 expired in 2020, 1..5 in January 2027, none from 6 on;
 * - branch: Norte for even, Sul for odd, none for 11.
 */
const SEED = Array.from({ length: 12 }, (_, index) => ({
  index,
  name: `Motorista ${String.fromCharCode(65 + index)}`,
  status: index % 4 === 0 ? ("INACTIVE" as const) : ("ACTIVE" as const),
  contract_type:
    index % 3 === 0 ? ("THIRD_PARTY" as const) : ("OWNED" as const),
  cnh_category:
    index % 3 === 0 ? ("E" as const) : index % 3 === 1 ? ("AB" as const) : null,
  cnh_expires_at:
    index === 0
      ? new Date("2020-01-01T00:00:00.000Z")
      : index <= 5
        ? new Date(`2027-01-0${index}T00:00:00.000Z`)
        : null,
  branchId: index === 11 ? null : index % 2 === 0 ? NORTE : SUL,
  cpf: `${String(100 + index)}45678900`,
  cnh: `9${String(index).padStart(10, "0")}`,
}));

const names = (indexes: number[]) => indexes.map((index) => SEED[index].name);

interface ListMeta {
  total: number;
  page: number;
  pageSize: number;
  searchMeta: {
    total: number;
    active: number;
    inactive: number;
    owned: number;
    thirdParty: number;
    facets: Record<
      string,
      Array<{ value: string; label?: string; count: number }>
    >;
  };
}

interface ListRow {
  id: string;
  name: string;
  businessId: string;
  cnh_status: string | null;
  branch: { corporate_reason: string } | null;
}

async function list(
  query: string,
  token = tokens.admin,
  page = 1,
): Promise<{ status: number; meta: ListMeta; rows: ListRow[]; body: string }> {
  const response = await app.inject({
    method: "GET",
    url: `/driver/list-driver?page=${page}&pageSize=10${query ? `&${query}` : ""}`,
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

const facet = (meta: ListMeta, name: string) =>
  Object.fromEntries(
    meta.searchMeta.facets[name].map((entry) => [entry.value, entry.count]),
  );

beforeAll(async () => {
  await seedBusiness(CARRIER);
  await seedBusiness(OTHER);

  await seedBranch(NORTE, CARRIER, "Filial Norte");
  await seedBranch(SUL, CARRIER, "Filial Sul");
  await seedBranch(FOREIGN_BRANCH, OTHER, "Filial secreta alheia");

  const start = Date.now() - 60 * 60 * 1000;

  for (const entry of SEED) {
    await prisma.driver.create({
      data: {
        name: entry.name,
        birth_date: new Date("1990-01-01T03:00:00.000Z"),
        cnh: entry.cnh,
        cpf: entry.cpf,
        cnh_category: entry.cnh_category,
        cnh_expires_at: entry.cnh_expires_at,
        rg: "123456789",
        cep: "01001000",
        city: "São Paulo",
        uf: "SP",
        street: "Rua",
        address_number: String(entry.index + 1),
        status: entry.status,
        contract_type: entry.contract_type,
        businessId: CARRIER,
        branchId: entry.branchId,
        created_at: new Date(start + entry.index * 60_000),
      },
    });
  }

  // Another carrier: the same person (same CPF and CNH as "Motorista B"),
  // registered there too — allowed since decision 8.1 — plus one of its own.
  await prisma.driver.create({
    data: {
      name: "Motorista Alheio",
      birth_date: new Date("1990-01-01T03:00:00.000Z"),
      cnh: SEED[1].cnh,
      cpf: SEED[1].cpf,
      rg: "123456789",
      cep: "01001000",
      city: "Rio de Janeiro",
      uf: "RJ",
      street: "Rua",
      address_number: "1",
      status: "INACTIVE",
      contract_type: "OWNED",
      businessId: OTHER,
      branchId: FOREIGN_BRANCH,
    },
  });

  tokens.admin = await seedUser("BUSINESS_ADMIN", CARRIER);
  tokens.readOnly = await seedUser("BUSINESS_USER", CARRIER, {
    profileAccessId: await seedProfile(CARRIER, "driver_manage", false),
  });
  tokens.dispatcher = await seedUser("BUSINESS_USER", CARRIER, {
    profileAccessId: await seedProfile(CARRIER, "delivery_manage", true),
  });
  // An active driver of this carrier, with the app's own token.
  const ownDriver = await prisma.driver.findFirstOrThrow({
    where: { businessId: CARRIER, name: SEED[1].name },
  });

  tokens.driver = await seedUser("BUSINESS_USER", CARRIER, {
    driverId: ownDriver.id,
  });
  tokens.otherAdmin = await seedUser("BUSINESS_ADMIN", OTHER);
  tokens.master = await seedUser("MASTER", null);

  ({ app } = await import("@/http"));
  await app.ready();
}, 90_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

describe("GET /driver/list-driver — order", () => {
  it("defaults to newest first over the whole company, and page 2 continues it", async () => {
    const first = await list("");
    const second = await list("", tokens.admin, 2);

    expect(first.status).toBe(200);
    expect(first.meta.total).toBe(12);
    expect(first.rows.map((row) => row.name)).toEqual(
      names([11, 10, 9, 8, 7, 6, 5, 4, 3, 2]),
    );
    expect(second.rows.map((row) => row.name)).toEqual(names([1, 0]));
  });

  it("sorts by name in both directions across pages", async () => {
    const asc = await list("sort=name&order=asc");
    const ascPage2 = await list("sort=name&order=asc", tokens.admin, 2);
    const desc = await list("sort=name&order=desc");

    expect(asc.rows.map((row) => row.name)).toEqual(
      names([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]),
    );
    expect(ascPage2.rows.map((row) => row.name)).toEqual(names([10, 11]));
    expect(desc.rows[0].name).toBe(SEED[11].name);
  });

  it("puts drivers without a CNH expiry last in both directions", async () => {
    const asc = await list("sort=cnh_expires_at&order=asc");
    const desc = await list("sort=cnh_expires_at&order=desc");

    expect(asc.rows.slice(0, 6).map((row) => row.name)).toEqual(
      names([0, 1, 2, 3, 4, 5]),
    );
    expect(desc.rows.slice(0, 6).map((row) => row.name)).toEqual(
      names([5, 4, 3, 2, 1, 0]),
    );
  });

  it("orders categories as the licence classes are declared (E before AB), blanks last", async () => {
    const asc = await list("sort=cnh_category&order=asc");

    const categories = asc.rows.map(
      (row) => SEED.find((entry) => entry.name === row.name)!.cnh_category,
    );

    // E ×4, AB ×4, then the blanks; inside a tie, newest first.
    expect(categories.slice(0, 8)).toEqual([
      "E",
      "E",
      "E",
      "E",
      "AB",
      "AB",
      "AB",
      "AB",
    ]);
    expect(asc.rows.slice(0, 4).map((row) => row.name)).toEqual(
      names([9, 6, 3, 0]),
    );
  });
});

describe("GET /driver/list-driver — filters and cards", () => {
  it("filters by status, one value or several, comma or repeated", async () => {
    expect((await list("status=INACTIVE")).meta.total).toBe(3);
    expect((await list("status=ACTIVE,INACTIVE")).meta.total).toBe(12);
    expect((await list("status=ACTIVE&status=INACTIVE")).meta.total).toBe(12);
  });

  it("combines facets with each other, with search and with sort", async () => {
    const combined = await list(
      "status=ACTIVE&contract_type=THIRD_PARTY&sort=name&order=desc",
    );

    expect(combined.rows.map((row) => row.name)).toEqual(names([9, 6, 3]));

    const searched = await list("status=ACTIVE&search=Motorista%20J");

    expect(searched.rows.map((row) => row.name)).toEqual(names([9]));
  });

  it("finds drivers without a category, and mixes it with a class", async () => {
    expect((await list("cnh_category=NONE")).meta.total).toBe(4);
    expect((await list("cnh_category=E,NONE")).meta.total).toBe(8);
  });

  it("filters by branch and names the branches from this company only", async () => {
    const norte = await list(`branchId=${NORTE}`);

    expect(norte.meta.total).toBe(6);
    expect(
      norte.rows.every(
        (row) => row.branch?.corporate_reason === "Filial Norte",
      ),
    ).toBe(true);

    const options = norte.meta.searchMeta.facets.branchId;

    expect(options).toEqual([
      { value: NORTE, label: "Filial Norte", count: 6 },
      { value: SUL, label: "Filial Sul", count: 5 },
    ]);
  });

  it("counts the cards over the whole company, disjunctively", async () => {
    const { meta, rows } = await list("status=INACTIVE");

    expect(rows).toHaveLength(3);
    expect(meta.searchMeta).toMatchObject({
      total: 12,
      active: 9,
      inactive: 3,
      // Contract breakdown WITH the status filter: drivers #4 and #8 are
      // owned, driver #0 is third party.
      owned: 2,
      thirdParty: 1,
    });
    expect(facet(meta, "status")).toEqual({ ACTIVE: 9, INACTIVE: 3 });
    expect(facet(meta, "cnh_category")).toMatchObject({ E: 1, AB: 1, NONE: 1 });
  });

  it("says where each CNH stands on the company's day", async () => {
    const { rows } = await list("sort=name&order=asc");

    expect(rows[0].cnh_status).toBe("EXPIRED");
    expect(rows[1].cnh_status).toBe("VALID");
    expect(rows[6].cnh_status).toBeNull();
  });

  it("refuses a sort, a status or an id it does not know", async () => {
    const badSort = await list("sort=cpf");
    const badStatus = await list("status=BLOCKED");
    const badId = await list("branchId=nao-e-um-id");

    expect(badSort.status).toBe(400);
    expect(badSort.body).toContain("Ordenação inválida");
    expect(badStatus.status).toBe(400);
    expect(badStatus.body).toContain("Valor de filtro inválido");
    expect(badId.status).toBe(400);
  });
});

describe("GET /driver/list-driver — tenants and roles", () => {
  it("never lists another company's driver, even one with the same CPF", async () => {
    const all = await list("search=Alheio");

    expect(all.meta.total).toBe(0);

    const byCpf = await list(`search=${SEED[1].cpf}`);

    expect(byCpf.rows.map((row) => row.name)).toEqual(names([1]));
  });

  it("brings no row and no name back for another company's branch id", async () => {
    const { meta, body } = await list(`branchId=${FOREIGN_BRANCH}`);

    expect(meta.total).toBe(0);
    expect(body).not.toContain("Filial secreta alheia");
  });

  it("refuses another company's manager who names this company", async () => {
    const { status, body } = await list(
      `businessId=${CARRIER}`,
      tokens.otherAdmin,
    );

    expect(status).toBe(403);
    expect(body).toContain("TENANT_ACCESS_DENIED");
  });

  it("asks the master which company, and lists only that one", async () => {
    const without = await list("", tokens.master);

    expect(without.status).toBe(400);
    expect(without.body).toContain("BUSINESS_NOT_IDENTIFIED");

    const withIt = await list(`businessId=${CARRIER}`, tokens.master);

    expect(withIt.status).toBe(200);
    expect(withIt.meta.total).toBe(12);
    expect(withIt.rows.every((row) => row.businessId === CARRIER)).toBe(true);
  });

  it("lets a read-only profile list, and refuses a profile without the driver catalogue", async () => {
    expect((await list("", tokens.readOnly)).status).toBe(200);

    const dispatcher = await list("", tokens.dispatcher);

    expect(dispatcher.status).toBe(403);
    expect(dispatcher.body).toContain("PERMISSION_DENIED");
  });

  it("refuses a driver token", async () => {
    const { status, body } = await list("", tokens.driver);

    expect(status).toBe(403);
    expect(body).toContain("PERMISSION_DENIED");
  });
});

async function exportCsv(query: string, token = tokens.admin) {
  const response = await app.inject({
    method: "GET",
    url: `/driver/export-driver?format=csv${query ? `&${query}` : ""}`,
    headers: { authorization: `Bearer ${token}` },
  });

  const lines = response.body
    .replace(/^﻿/, "")
    .trim()
    .split("\n")
    .filter(Boolean);

  return { response, header: lines[0] ?? "", rows: lines.slice(1) };
}

describe("GET /driver/export-driver", () => {
  it("exports the list's filter, not the whole company", async () => {
    const { response, header, rows } = await exportCsv(
      "status=INACTIVE&sort=name&order=asc",
    );

    expect(response.statusCode).toBe(200);
    expect(header).toContain("Categoria da CNH");
    expect(header).toContain("Validade da CNH");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain(SEED[0].name);
    // The expiry is a civil date: the day stored, no time, no zone shift.
    expect(rows[0]).toContain("01/01/2020");
  });

  it("follows the search too", async () => {
    const { rows } = await exportCsv("search=Motorista%20C");

    expect(rows).toHaveLength(1);
  });

  it("answers 400 NOTHING_TO_EXPORT when the filter keeps nobody, like the other exports", async () => {
    // Red before: 200 with a header-only file.
    const { response } = await exportCsv("search=ninguem-com-este-nome");

    expect(response.statusCode, response.body).toBe(400);
    expect(response.json().code).toBe("NOTHING_TO_EXPORT");
    expect(response.json().message).toBe(
      "Não existem motoristas para exportar!",
    );
  });

  it("names the file with the company's business day", async () => {
    const { response } = await exportCsv("");
    const today = businessDateKey(new Date(), "America/Sao_Paulo");

    expect(response.headers["content-disposition"]).toContain(
      `relatorio-motoristas-${today}.csv`,
    );
  });

  it("asks the master which company, and exports only that one", async () => {
    const without = await exportCsv("", tokens.master);

    expect(without.response.statusCode).toBe(400);
    expect(without.response.body).toContain("BUSINESS_NOT_IDENTIFIED");

    const withIt = await exportCsv(`businessId=${OTHER}`, tokens.master);

    expect(withIt.response.statusCode).toBe(200);
    expect(withIt.rows).toHaveLength(1);
    expect(withIt.rows[0]).toContain("Motorista Alheio");
  });

  it("refuses another company's manager and a read-only profile", async () => {
    const foreign = await exportCsv(`businessId=${CARRIER}`, tokens.otherAdmin);

    expect(foreign.response.statusCode).toBe(403);

    const readOnly = await exportCsv("", tokens.readOnly);

    expect(readOnly.response.statusCode).toBe(403);
    expect(readOnly.response.body).toContain("PERMISSION_DENIED");
  });
});
