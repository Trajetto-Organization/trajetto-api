import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient, type QuoteStatus } from "@prisma/client";
import { sign } from "jsonwebtoken";

import { randomUUID } from "node:crypto";

import auth from "@/config/auth";

/**
 * GET /quote/list-quote over real HTTP and Postgres (decision 8.8).
 *
 * The /admin quotes screen counted "Pendentes", "Contatados" and
 * "Convertidos" on the ten rows of the page and filtered stage, company and
 * fleet size among them. The order, the stage and fleet-size facets and the
 * per-stage cards are the server's now, over every quote.
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const tokens: Record<"master" | "admin", string> = {} as never;

const BASE = Date.UTC(2026, 8, 1, 12, 0, 0);

interface Seed {
  key: string;
  status: QuoteStatus;
  fleet: string;
  /** Minutes after BASE; equal values make a created_at tie. */
  at: number;
  contacted?: number;
  id?: string;
  phone?: string;
}

// Two created_at ties: in A the row inserted first has the BIGGER id, in B
// the SMALLER one.
const SEEDS: Seed[] = [
  { key: "Q01", status: "PENDING", fleet: "1-5", at: 1 },
  { key: "Q02", status: "PENDING", fleet: "6-15", at: 2 },
  { key: "Q03", status: "CONTACTED", fleet: "1-5", at: 3, contacted: 30 },
  { key: "Q04", status: "CONTACTED", fleet: "16-30", at: 4, contacted: 10 },
  { key: "Q05", status: "CLOSED", fleet: "1-5", at: 5, contacted: 20 },
  { key: "Q06", status: "CONVERTED", fleet: "101+", at: 6 },
  { key: "Q07", status: "CONVERTED", fleet: "1-5", at: 7 },
  { key: "Q08", status: "PENDING", fleet: "1-5", at: 8, phone: "5565999887766" },
  { key: "Q09", status: "PENDING", fleet: "31-50", at: 9 },
  { key: "A1", status: "PENDING", fleet: "1-5", at: 10, id: "018fed30-0000-7000-8000-0000000000a9" },
  { key: "A2", status: "CONTACTED", fleet: "6-15", at: 10, contacted: 40, id: "018fed30-0000-7000-8000-0000000000a1" },
  { key: "B1", status: "PENDING", fleet: "51-100", at: 11, id: "018fed30-0000-7000-8000-0000000000b1" },
  { key: "B2", status: "CLOSED", fleet: "1-5", at: 11, contacted: 50, id: "018fed30-0000-7000-8000-0000000000b9" },
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
    url: `/quote/list-quote?page=${page}&pageSize=10${query ? `&${query}` : ""}`,
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
    keys: rows.map((row) => String(row.name).replace("Pessoa ", "")),
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

beforeAll(async () => {
  const business = await prisma.business.create({
    data: {
      corporate_reason: "Transportadora Orçamentos",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: "61222555000100",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: "orcamentos@exemplo.com.br",
    },
  });

  // One by one, in this order: the tie pairs' insertion order is known.
  for (const seed of SEEDS) {
    await prisma.quote.create({
      data: {
        ...(seed.id && { id: seed.id }),
        name: `Pessoa ${seed.key}`,
        company: `Frota ${seed.key}`,
        email: `${seed.key.toLowerCase()}@lead.exemplo.com.br`,
        telephone: seed.phone ?? "11988887777",
        fleet_size: seed.fleet,
        status: seed.status,
        contacted_at:
          seed.contacted === undefined ? null : new Date(BASE + seed.contacted * 60_000),
        created_at: new Date(BASE + seed.at * 60_000),
      },
    });
  }

  tokens.master = await seedUser("MASTER", null);
  tokens.admin = await seedUser("BUSINESS_ADMIN", business.id);

  ({ app } = await import("@/http"));
  await app.ready();
}, 90_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

describe("GET /quote/list-quote — order", () => {
  it("defaults to newest first across pages, the ties broken by id desc", async () => {
    expect(await allPages("")).toEqual([
      "B2", "B1", "A1", "A2", "Q09", "Q08", "Q07", "Q06", "Q05", "Q04", "Q03", "Q02", "Q01",
    ]);
  });

  it("orders created_at ascending with the same id tiebreaker in both pairs", async () => {
    expect(await allPages("sort=created_at&order=asc")).toEqual([
      "Q01", "Q02", "Q03", "Q04", "Q05", "Q06", "Q07", "Q08", "Q09", "A1", "A2", "B2", "B1",
    ]);
  });

  it("orders the stage by the pipeline, not alphabetically", async () => {
    const keys = await allPages("sort=status&order=asc");
    const stages = keys.map((key) => SEEDS.find((seed) => seed.key === key)?.status);
    const rank = { PENDING: 0, CONTACTED: 1, CLOSED: 2, CONVERTED: 3 } as const;

    expect(stages.map((stage) => rank[stage as keyof typeof rank])).toEqual(
      [...stages.map((stage) => rank[stage as keyof typeof rank])].sort((a, b) => a - b),
    );
    // Inside a stage, the newest first (the tiebreaker).
    expect(keys.slice(0, 6)).toEqual(["B1", "A1", "Q09", "Q08", "Q02", "Q01"]);
  });

  it("keeps the never contacted last, both ways", async () => {
    const asc = await allPages("sort=contacted_at&order=asc");
    const desc = await allPages("sort=contacted_at&order=desc");

    expect(asc.slice(0, 5)).toEqual(["Q04", "Q05", "Q03", "A2", "B2"]);
    expect(desc.slice(0, 5)).toEqual(["B2", "A2", "Q03", "Q05", "Q04"]);
    // The rest never contacted, newest first, in both directions.
    expect(asc.slice(5)).toEqual(desc.slice(5));
  });
});

describe("GET /quote/list-quote — filters and cards over every quote", () => {
  it("counts the per-stage cards over all thirteen, not over the page", async () => {
    const result = await list("");

    expect(result.total).toBe(13);
    expect(result.searchMeta).toMatchObject({
      total: 13,
      pending: 6,
      contacted: 3,
      closed: 2,
      converted: 2,
    });
  });

  it("filters stage and fleet size, the stage cards counting without the stage filter", async () => {
    const result = await list("status=PENDING&fleet_size=1-5");

    expect(result.total).toBe(3);
    expect(result.keys).toEqual(["A1", "Q08", "Q01"]);
    // Picking "Pendente" narrows the table; the other stages keep counting
    // under the fleet-size filter.
    expect(result.searchMeta).toMatchObject({
      total: 3,
      pending: 3,
      contacted: 1,
      closed: 2,
      converted: 1,
    });
    expect(result.searchMeta.facets.fleet_size).toEqual([
      { value: "1-5", count: 3 },
      { value: "6-15", count: 1 },
      { value: "16-30", count: 0 },
      { value: "31-50", count: 1 },
      { value: "51-100", count: 1 },
      { value: "101+", count: 0 },
    ]);
  });

  it("accepts a facet repeated as well as comma-separated, with an order", async () => {
    const comma = await list("status=CLOSED,CONVERTED&sort=created_at&order=asc");
    const repeated = await list("status=CLOSED&status=CONVERTED&sort=created_at&order=asc");

    expect(comma.keys).toEqual(["Q05", "Q06", "Q07", "B2"]);
    expect(repeated.keys).toEqual(comma.keys);
  });

  it("finds a quote by the digits of its phone, the country code dropped", async () => {
    expect((await list(`search=${encodeURIComponent("+55 (65) 99988-7766")}`)).keys).toEqual([
      "Q08",
    ]);
  });

  it("refuses an order or a filter value the list does not offer", async () => {
    expect((await list("sort=telephone")).status).toBe(400);
    expect((await list("status=LOST")).status).toBe(400);
    expect((await list("fleet_size=1000")).status).toBe(400);
  });

  it("is the MASTER's alone", async () => {
    const refused = await list("", tokens.admin);

    expect(refused.status).toBe(403);
    expect(refused.body).not.toContain("lead.exemplo");
  });
});
