import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { sign } from "jsonwebtoken";

import { randomUUID } from "node:crypto";

import auth from "@/config/auth";

/**
 * GET /business/list-business over real HTTP and Postgres (decision 8.8).
 *
 * The /admin companies screen counted "Com código ERP", "Por Estado" and
 * "Por Cidade" on the ten rows of the page and filtered name, city and CNPJ
 * among them. The order, the status and UF facets and the cards are now the
 * server's, over every company, with the disjunctive rule.
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const tokens: Record<"master" | "admin", string> = {} as never;

const BASE = Date.UTC(2026, 8, 1, 12, 0, 0);

interface Seed {
  key: string;
  city: string;
  uf: string;
  active?: boolean;
  erp?: string | null;
  fantasy?: string | null;
  /** Minutes after BASE; equal values make a created_at tie. */
  at: number;
  id?: string;
}

// Two created_at ties: in A the row inserted first has the BIGGER id, in B
// the SMALLER one — `id desc` must decide both, in both directions.
const SEEDS: Seed[] = [
  { key: "E01", city: "São Paulo", uf: "SP", erp: "ERP-01", fantasy: "Alfa", at: 1 },
  { key: "E02", city: "São Paulo", uf: "SP", erp: null, fantasy: null, at: 2 },
  { key: "E03", city: "São Paulo", uf: "SP", erp: "ERP-03", fantasy: "Bravo", at: 3 },
  { key: "E04", city: "São Paulo", uf: "SP", erp: null, fantasy: "Charlie", at: 4 },
  { key: "E05", city: "Campinas", uf: "SP", erp: "ERP-05", fantasy: null, at: 5 },
  { key: "E06", city: "São José", uf: "SC", erp: null, fantasy: "Delta", at: 6 },
  { key: "E07", city: "São José", uf: "SC", erp: "ERP-07", fantasy: "Echo", at: 7 },
  { key: "E08", city: "São José", uf: "SP", erp: null, fantasy: null, at: 8 },
  { key: "E09", city: "Cuiabá", uf: "MT", erp: "ERP-09", fantasy: "Foxtrot", at: 9 },
  {
    key: "A1", city: "Cuiabá", uf: "MT", erp: null, fantasy: "Golf", at: 10,
    id: "018fed10-0000-7000-8000-0000000000a9",
  },
  {
    key: "A2", city: "Cuiabá", uf: "MT", erp: "ERP-A2", fantasy: "Hotel", at: 10,
    id: "018fed10-0000-7000-8000-0000000000a1",
  },
  {
    key: "B1", city: "Manaus", uf: "AM", active: false, erp: null, fantasy: "India", at: 11,
    id: "018fed10-0000-7000-8000-0000000000b1",
  },
  {
    key: "B2", city: "Manaus", uf: "AM", active: false, erp: "ERP-B2", fantasy: null, at: 11,
    id: "018fed10-0000-7000-8000-0000000000b9",
  },
  { key: "E14", city: "Rio de Janeiro", uf: "RJ", active: false, erp: null, fantasy: "Juliet", at: 12 },
];

async function seedUser(
  role: "MASTER" | "BUSINESS_ADMIN",
  businessId: string | null,
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

  return sign({ tokenType: "access", sessionVersion: 0, familyId }, auth.secret_token, {
    subject: id,
    expiresIn: "15m",
  });
}

interface ListResult {
  status: number;
  keys: string[];
  total: number;
  searchMeta: any;
  body: string;
}

async function list(query: string, token = tokens.master, page = 1): Promise<ListResult> {
  const response = await app.inject({
    method: "GET",
    url: `/business/list-business?page=${page}&pageSize=10${query ? `&${query}` : ""}`,
    headers: { authorization: `Bearer ${token}` },
  });

  if (response.statusCode !== 200) {
    return { status: response.statusCode, keys: [], total: 0, searchMeta: null, body: response.body };
  }

  const [first, ...rows] = response.body
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  return {
    status: 200,
    keys: rows.map((row) => String(row.corporate_reason).replace("Empresa ", "")),
    total: first.meta.total,
    searchMeta: first.meta.searchMeta,
    body: response.body,
  };
}

/** Pages 1 and 2 of ten: the order must carry across the page boundary. */
async function allPages(query: string): Promise<string[]> {
  const first = await list(query);
  const second = await list(query, tokens.master, 2);

  return [...first.keys, ...second.keys];
}

const SAO_JOSE = encodeURIComponent("são josé");

beforeAll(async () => {
  // Inserted one by one, in this order, so the tie pairs' insertion order is known.
  for (const [index, seed] of SEEDS.entries()) {
    await prisma.business.create({
      data: {
        ...(seed.id && { id: seed.id }),
        corporate_reason: `Empresa ${seed.key}`,
        fantasy_name: seed.fantasy ?? null,
        cep: "01001000",
        city: seed.city,
        uf: seed.uf,
        street: "Rua",
        address_number: "1",
        cnpj: String(71222555000100 + index),
        cnae: "4930202",
        erp_code: seed.erp ?? null,
        responsible_name: "Responsável",
        telephone: "11999999999",
        email: `${seed.key.toLowerCase()}@lista.exemplo.com.br`,
        is_active: seed.active ?? true,
        created_at: new Date(BASE + seed.at * 60_000),
      },
    });
  }

  tokens.master = await seedUser("MASTER", null);
  tokens.admin = await seedUser(
    "BUSINESS_ADMIN",
    (await prisma.business.findFirstOrThrow({ where: { corporate_reason: "Empresa E01" } })).id,
  );

  ({ app } = await import("@/http"));
  await app.ready();
}, 90_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

describe("GET /business/list-business — order", () => {
  it("defaults to newest first across pages, the ties broken by id desc", async () => {
    const keys = await allPages("");

    expect(keys).toEqual([
      "E14", "B2", "B1", "A1", "A2", "E09", "E08", "E07", "E06", "E05", "E04", "E03", "E02", "E01",
    ]);
  });

  it("orders created_at ascending with the same id tiebreaker (desc) in both pairs", async () => {
    const keys = await allPages("sort=created_at&order=asc");

    expect(keys).toEqual([
      "E01", "E02", "E03", "E04", "E05", "E06", "E07", "E08", "E09", "A1", "A2", "B2", "B1", "E14",
    ]);
  });

  it("orders by a text column across pages, both ways", async () => {
    const asc = await allPages("sort=corporate_reason&order=asc");

    expect(asc).toEqual([...asc].sort());
    expect(await allPages("sort=corporate_reason&order=desc")).toEqual([...asc].reverse());
  });

  it("keeps the companies without an ERP code or a trade name last, both ways", async () => {
    const withoutErp = SEEDS.filter((seed) => !seed.erp).length;

    for (const order of ["asc", "desc"]) {
      const keys = await allPages(`sort=erp_code&order=${order}`);
      const tail = keys.slice(keys.length - withoutErp);

      expect(tail.every((key) => !SEEDS.find((seed) => seed.key === key)?.erp), order).toBe(true);
    }

    const byTradeName = await allPages("sort=fantasy_name&order=desc");
    const firstNull = byTradeName.findIndex(
      (key) => !SEEDS.find((seed) => seed.key === key)?.fantasy,
    );

    expect(
      byTradeName.slice(firstNull).every((key) => !SEEDS.find((seed) => seed.key === key)?.fantasy),
    ).toBe(true);
    // Juliet … Alfa, then the NULLs.
    expect(byTradeName[0]).toBe("E14");
  });
});

describe("GET /business/list-business — filters and cards over every company", () => {
  it("counts the cards over all fourteen, not over the page", async () => {
    const result = await list("");

    expect(result.total).toBe(14);
    expect(result.searchMeta).toMatchObject({
      total: 14,
      withErpCode: SEEDS.filter((seed) => seed.erp).length,
      // SP 6 (São Paulo 4, Campinas, São José), MT 3; AM and SC tie at 2, AM first.
      topStates: [
        { value: "SP", count: 6 },
        { value: "MT", count: 3 },
        { value: "AM", count: 2 },
      ],
      // "São José" of SC and of SP are two places.
      topCities: [
        { value: "São Paulo/SP", count: 4 },
        { value: "Cuiabá/MT", count: 3 },
        { value: "Manaus/AM", count: 2 },
      ],
    });
  });

  it("filters status and UF on the server, counting each facet without itself", async () => {
    const result = await list("status=active&uf=SP,AM");

    expect(result.total).toBe(6);
    expect(result.keys).toHaveLength(6);

    const { status, uf } = result.searchMeta.facets;

    // Status options with the UF filter applied, not the status one.
    expect(status).toEqual([
      { value: "active", count: 6 },
      { value: "inactive", count: 2 },
    ]);
    // UF options with the status filter applied: AM has no active company
    // but stays, selected, with zero.
    expect(uf).toEqual(
      expect.arrayContaining([
        { value: "AM", count: 0 },
        { value: "SP", count: 6 },
        { value: "MT", count: 3 },
        { value: "SC", count: 2 },
      ]),
    );
    expect(uf.find((option: { value: string }) => option.value === "RJ")).toBeUndefined();

    // "Por Estado" is a breakdown by UF: status applied, UF not.
    expect(result.searchMeta.topStates).toEqual([
      { value: "SP", count: 6 },
      { value: "MT", count: 3 },
      { value: "SC", count: 2 },
    ]);
    // "Por Cidade" is not a facet: every filter applies.
    expect(result.searchMeta.topCities).toEqual([
      { value: "São Paulo/SP", count: 4 },
      { value: "Campinas/SP", count: 1 },
      { value: "São José/SP", count: 1 },
    ]);
  });

  it("accepts a facet repeated as well as comma-separated, with the search and an order", async () => {
    const comma = await list(`uf=SC,SP&search=${SAO_JOSE}&sort=uf&order=asc`);
    const repeated = await list(`uf=SC&uf=SP&search=${SAO_JOSE}&sort=uf&order=asc`);

    expect(comma.keys).toEqual(["E07", "E06", "E08"]);
    expect(repeated.keys).toEqual(comma.keys);
    expect(comma.searchMeta.topCities).toEqual([
      { value: "São José/SC", count: 2 },
      { value: "São José/SP", count: 1 },
    ]);
  });

  it("finds a company by the digits of its CNPJ", async () => {
    const result = await list("search=71.222.555/0001-13");

    expect(result.keys).toEqual(["E14"]);
  });

  it("refuses an order or a filter value the list does not offer", async () => {
    expect((await list("sort=telephone")).status).toBe(400);
    expect((await list("status=frozen")).status).toBe(400);
    expect((await list("uf=XX")).status).toBe(400);
  });

  it("is the MASTER's alone", async () => {
    const refused = await list("", tokens.admin);

    expect(refused.status).toBe(403);
    expect(refused.body).not.toContain("Empresa E02");
  });
});
