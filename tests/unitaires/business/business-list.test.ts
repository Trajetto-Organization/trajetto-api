import "reflect-metadata";

import { beforeEach, describe, expect, it } from "vitest";

import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";
import { ListBusinessUseCase } from "@/modules/business/usecases/list-business/list-business-usecase";
import {
  summarizeBusinessList,
  topPlaces,
} from "@/modules/business/usecases/list-business/business-list";

import type { Business } from "@/modules/business/dtos/business-dto";

/**
 * The companies list (decision 8.8): cards and facet options from the
 * server's breakdowns, with the disjunctive rule, and a twin that answers
 * the same order and filters as tests/E2E/business-list-http.test.ts proves
 * on Postgres.
 */

const BASE = Date.UTC(2026, 8, 1, 12, 0, 0);

interface Seed {
  key: string;
  city: string;
  uf: string;
  active?: boolean;
  erp?: string | null;
  fantasy?: string | null;
  at: number;
  id?: string;
}

// The same fourteen companies as the E2E, tie pairs included.
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
  { key: "A1", city: "Cuiabá", uf: "MT", erp: null, fantasy: "Golf", at: 10, id: "018fed10-0000-7000-8000-0000000000a9" },
  { key: "A2", city: "Cuiabá", uf: "MT", erp: "ERP-A2", fantasy: "Hotel", at: 10, id: "018fed10-0000-7000-8000-0000000000a1" },
  { key: "B1", city: "Manaus", uf: "AM", active: false, erp: null, fantasy: "India", at: 11, id: "018fed10-0000-7000-8000-0000000000b1" },
  { key: "B2", city: "Manaus", uf: "AM", active: false, erp: "ERP-B2", fantasy: null, at: 11, id: "018fed10-0000-7000-8000-0000000000b9" },
  { key: "E14", city: "Rio de Janeiro", uf: "RJ", active: false, erp: null, fantasy: "Juliet", at: 12 },
];

let repository: InMemoryBusinessRepository;
let useCase: ListBusinessUseCase;

const master = { id: "master", role: "MASTER", businessId: null };
const users = { findUserById: async (id: string) => (id === "master" ? master : null) } as never;

beforeEach(() => {
  repository = new InMemoryBusinessRepository();

  repository.business = SEEDS.map(
    (seed, index): Business => ({
      id: seed.id ?? `018fed20-0000-7000-8000-${String(index).padStart(12, "0")}`,
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
      timezone: "America/Sao_Paulo",
      created_at: new Date(BASE + seed.at * 60_000),
      updated_at: new Date(BASE + seed.at * 60_000),
    }),
  );

  useCase = new ListBusinessUseCase(users, repository);
});

const keysOf = (rows: Business[]) => rows.map((row) => row.corporate_reason.replace("Empresa ", ""));

async function allPages(request: Partial<Parameters<ListBusinessUseCase["execute"]>[0]> = {}) {
  const first = await useCase.execute({ userId: "master", page: 1, pageSize: 10, ...request });
  const second = await useCase.execute({ userId: "master", page: 2, pageSize: 10, ...request });

  return [...keysOf(first.data), ...keysOf(second.data)];
}

describe("the twin answers like Postgres", () => {
  it("orders newest first, the created_at ties broken by id desc in both pairs", async () => {
    expect(await allPages()).toEqual([
      "E14", "B2", "B1", "A1", "A2", "E09", "E08", "E07", "E06", "E05", "E04", "E03", "E02", "E01",
    ]);

    expect(await allPages({ sort: "created_at", order: "asc" })).toEqual([
      "E01", "E02", "E03", "E04", "E05", "E06", "E07", "E08", "E09", "A1", "A2", "B2", "B1", "E14",
    ]);
  });

  it("keeps a NULL ERP code last in both directions", async () => {
    for (const order of ["asc", "desc"] as const) {
      const keys = await allPages({ sort: "erp_code", order });
      const withoutErp = SEEDS.filter((seed) => !seed.erp).length;

      expect(
        keys.slice(keys.length - withoutErp).every((key) => !SEEDS.find((seed) => seed.key === key)?.erp),
        order,
      ).toBe(true);
    }
  });

  it("filters, searches and counts like the repository", async () => {
    const result = await useCase.execute({
      userId: "master",
      page: 1,
      pageSize: 10,
      search: "são josé",
      ufs: ["SC", "SP"],
      sort: "uf",
      order: "asc",
    });

    expect(keysOf(result.data)).toEqual(["E07", "E06", "E08"]);
    expect(result.searchMeta.topCities).toEqual([
      { value: "São José/SC", count: 2 },
      { value: "São José/SP", count: 1 },
    ]);

    const byCnpj = await useCase.execute({
      userId: "master",
      page: 1,
      pageSize: 10,
      search: "71.222.555/0001-13",
    });

    expect(keysOf(byCnpj.data)).toEqual(["E14"]);
  });

  it("gives the cards and the facets of the E2E", async () => {
    const all = await useCase.execute({ userId: "master", page: 1, pageSize: 10 });

    expect(all.total).toBe(14);
    expect(all.searchMeta.topStates).toEqual([
      { value: "SP", count: 6 },
      { value: "MT", count: 3 },
      { value: "AM", count: 2 },
    ]);
    expect(all.searchMeta.topCities).toEqual([
      { value: "São Paulo/SP", count: 4 },
      { value: "Cuiabá/MT", count: 3 },
      { value: "Manaus/AM", count: 2 },
    ]);

    const filtered = await useCase.execute({
      userId: "master",
      page: 1,
      pageSize: 10,
      statuses: ["active"],
      ufs: ["SP", "AM"],
    });

    expect(filtered.total).toBe(6);
    expect(filtered.searchMeta.facets.status).toEqual([
      { value: "active", count: 6 },
      { value: "inactive", count: 2 },
    ]);
    expect(filtered.searchMeta.facets.uf).toEqual(
      expect.arrayContaining([
        { value: "AM", count: 0 },
        { value: "SP", count: 6 },
      ]),
    );
  });
});

describe("summarizeBusinessList — the disjunctive rule", () => {
  const groups = [
    { is_active: true, uf: "SP", count: 5, withErpCode: 2 },
    { is_active: false, uf: "SP", count: 1, withErpCode: 1 },
    { is_active: true, uf: "MT", count: 3, withErpCode: 0 },
    { is_active: false, uf: "AM", count: 2, withErpCode: 1 },
  ];

  it("counts each facet with the other applied, never itself", () => {
    const { total, searchMeta } = summarizeBusinessList(groups, [], {
      statuses: ["inactive"],
      ufs: ["SP"],
    });

    expect(total).toBe(1);
    expect(searchMeta.withErpCode).toBe(1);
    // Status options under the UF filter only.
    expect(searchMeta.facets.status).toEqual([
      { value: "active", count: 5 },
      { value: "inactive", count: 1 },
    ]);
    // UF options under the status filter only.
    expect(searchMeta.facets.uf).toEqual([
      { value: "AM", count: 2 },
      { value: "SP", count: 1 },
    ]);
    // "Por Estado" is broken down by UF: picking SP narrows the table, the
    // card still names the other states (status applied, UF not).
    expect(searchMeta.topStates).toEqual([
      { value: "AM", count: 2 },
      { value: "SP", count: 1 },
    ]);
  });

  it("both statuses selected is no status filter", () => {
    expect(
      summarizeBusinessList(groups, [], { statuses: ["active", "inactive"] }).total,
    ).toBe(11);
  });

  it("names at most three places, most first, the name breaking a tie", () => {
    expect(
      topPlaces(new Map([["SC", 2], ["AM", 2], ["SP", 6], ["RJ", 1], ["PR", 0]])),
    ).toEqual([
      { value: "SP", count: 6 },
      { value: "AM", count: 2 },
      { value: "SC", count: 2 },
    ]);
  });
});

describe("the twin's update answers like Prisma's", () => {
  it("clears a column sent as null and keeps one not sent", async () => {
    const [first] = repository.business;

    const updated = await repository.updateBusiness({
      businessId: first.id as string,
      businessData: { erp_code: null, fantasy_name: undefined },
    });

    // Prisma writes NULL for null and skips undefined; the twin dropped the
    // null too, so a cleared ERP code survived only in the tests.
    expect(updated.erp_code).toBeNull();
    expect(updated.fantasy_name).toBe("Alfa");
  });

  it("raises P2025 for a company that is not there", async () => {
    await expect(
      repository.updateBusiness({ businessId: "missing", businessData: { city: "X" } }),
    ).rejects.toMatchObject({ code: "P2025" });
  });
});
