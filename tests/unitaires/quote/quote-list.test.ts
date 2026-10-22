import "reflect-metadata";

import { beforeEach, describe, expect, it } from "vitest";

import { InMemoryQuoteRepository } from "@/modules/quote/repositories/in-memory/in-memory-quote-repository";
import { ListQuotesUseCase } from "@/modules/quote/usecases/list-quotes/list-quotes-usecase";
import { UpdateQuoteStatusUseCase } from "@/modules/quote/usecases/update-quote-status/update-quote-status-usecase";
import { summarizeQuoteList } from "@/modules/quote/usecases/list-quotes/quote-list";
import { QuoteAccessDeniedError } from "@/modules/quote/usecases/errors/quote-access denied-error";

import type { Quote, QuoteStatus } from "@/modules/quote/dtos/quote-dto";

/**
 * The quotes list (decision 8.8) and the twin behind the use-case tests,
 * answering as tests/E2E/quote-list-http.test.ts proves Postgres does.
 */

const BASE = Date.UTC(2026, 8, 1, 12, 0, 0);

interface Seed {
  key: string;
  status: QuoteStatus;
  fleet: string;
  at: number;
  contacted?: number;
  id?: string;
  phone?: string;
}

// The same thirteen quotes as the E2E, tie pairs included.
const SEEDS: Seed[] = [
  { key: "Q01", status: "PENDING", fleet: "1-5", at: 1 },
  { key: "Q02", status: "PENDING", fleet: "6-15", at: 2 },
  { key: "Q03", status: "CONTACTED", fleet: "1-5", at: 3, contacted: 30 },
  { key: "Q04", status: "CONTACTED", fleet: "16-30", at: 4, contacted: 10 },
  { key: "Q05", status: "CLOSED", fleet: "1-5", at: 5, contacted: 20 },
  { key: "Q06", status: "CONVERTED", fleet: "101+", at: 6 },
  { key: "Q07", status: "CONVERTED", fleet: "1-5", at: 7 },
  {
    key: "Q08",
    status: "PENDING",
    fleet: "1-5",
    at: 8,
    phone: "5565999887766",
  },
  { key: "Q09", status: "PENDING", fleet: "31-50", at: 9 },
  {
    key: "A1",
    status: "PENDING",
    fleet: "1-5",
    at: 10,
    id: "018fed30-0000-7000-8000-0000000000a9",
  },
  {
    key: "A2",
    status: "CONTACTED",
    fleet: "6-15",
    at: 10,
    contacted: 40,
    id: "018fed30-0000-7000-8000-0000000000a1",
  },
  {
    key: "B1",
    status: "PENDING",
    fleet: "51-100",
    at: 11,
    id: "018fed30-0000-7000-8000-0000000000b1",
  },
  {
    key: "B2",
    status: "CLOSED",
    fleet: "1-5",
    at: 11,
    contacted: 50,
    id: "018fed30-0000-7000-8000-0000000000b9",
  },
];

const people: Record<
  string,
  { id: string; role: string; businessId: string | null }
> = {
  master: { id: "master", role: "MASTER", businessId: null },
  admin: { id: "admin", role: "BUSINESS_ADMIN", businessId: "biz" },
};

const users = {
  findUserById: async (id: string) => people[id] ?? null,
} as never;

let repository: InMemoryQuoteRepository;
let useCase: ListQuotesUseCase;

beforeEach(() => {
  repository = new InMemoryQuoteRepository();

  repository.quotes = SEEDS.map(
    (seed, index): Quote => ({
      id:
        seed.id ?? `018fed40-0000-7000-8000-${String(index).padStart(12, "0")}`,
      name: `Pessoa ${seed.key}`,
      company: `Frota ${seed.key}`,
      email: `${seed.key.toLowerCase()}@lead.exemplo.com.br`,
      telephone: seed.phone ?? "11988887777",
      fleet_size: seed.fleet,
      message: null,
      status: seed.status,
      contacted_at:
        seed.contacted === undefined
          ? null
          : new Date(BASE + seed.contacted * 60_000),
      notes: null,
      created_at: new Date(BASE + seed.at * 60_000),
      updated_at: new Date(BASE + seed.at * 60_000),
    }),
  );

  useCase = new ListQuotesUseCase(users, repository);
});

const keysOf = (rows: Quote[]) =>
  rows.map((row) => row.name.replace("Pessoa ", ""));

async function allPages(
  request: Partial<Parameters<ListQuotesUseCase["execute"]>[0]> = {},
) {
  const first = await useCase.execute({
    userId: "master",
    page: 1,
    pageSize: 10,
    ...request,
  });
  const second = await useCase.execute({
    userId: "master",
    page: 2,
    pageSize: 10,
    ...request,
  });

  return [...keysOf(first.data), ...keysOf(second.data)];
}

describe("the twin answers like Postgres", () => {
  it("orders newest first, the ties broken by id desc, both ways", async () => {
    expect(await allPages()).toEqual([
      "B2",
      "B1",
      "A1",
      "A2",
      "Q09",
      "Q08",
      "Q07",
      "Q06",
      "Q05",
      "Q04",
      "Q03",
      "Q02",
      "Q01",
    ]);
    expect(await allPages({ sort: "created_at", order: "asc" })).toEqual([
      "Q01",
      "Q02",
      "Q03",
      "Q04",
      "Q05",
      "Q06",
      "Q07",
      "Q08",
      "Q09",
      "A1",
      "A2",
      "B2",
      "B1",
    ]);
  });

  it("orders the stage by the pipeline and keeps the never contacted last", async () => {
    expect(
      (await allPages({ sort: "status", order: "asc" })).slice(0, 6),
    ).toEqual(["B1", "A1", "Q09", "Q08", "Q02", "Q01"]);

    const asc = await allPages({ sort: "contacted_at", order: "asc" });
    const desc = await allPages({ sort: "contacted_at", order: "desc" });

    expect(asc.slice(0, 5)).toEqual(["Q04", "Q05", "Q03", "A2", "B2"]);
    expect(desc.slice(0, 5)).toEqual(["B2", "A2", "Q03", "Q05", "Q04"]);
    expect(asc.slice(5)).toEqual(desc.slice(5));
  });

  it("filters, searches and counts like the repository", async () => {
    const result = await useCase.execute({
      userId: "master",
      page: 1,
      pageSize: 10,
      statuses: ["PENDING"],
      fleetSizes: ["1-5"],
    });

    expect(keysOf(result.data)).toEqual(["A1", "Q08", "Q01"]);
    expect(result.searchMeta).toMatchObject({
      total: 3,
      pending: 3,
      contacted: 1,
      closed: 2,
      converted: 1,
    });

    const byPhone = await useCase.execute({
      userId: "master",
      page: 1,
      pageSize: 10,
      search: "+55 (65) 99988-7766",
    });

    expect(keysOf(byPhone.data)).toEqual(["Q08"]);
  });

  it("is refused to anyone but the MASTER", async () => {
    await expect(
      useCase.execute({ userId: "admin", page: 1, pageSize: 10 }),
    ).rejects.toBeInstanceOf(QuoteAccessDeniedError);
  });
});

describe("summarizeQuoteList — the disjunctive rule", () => {
  it("counts the stage cards without the stage filter, the total with every filter", () => {
    const { total, searchMeta } = summarizeQuoteList(
      [
        { status: "PENDING", fleet_size: "1-5", count: 4 },
        { status: "CONTACTED", fleet_size: "1-5", count: 2 },
        { status: "PENDING", fleet_size: "101+", count: 1 },
      ],
      { statuses: ["CONTACTED"], fleetSizes: ["1-5"] },
    );

    expect(total).toBe(2);
    expect(searchMeta).toMatchObject({
      total: 2,
      pending: 4,
      contacted: 2,
      closed: 0,
      converted: 0,
    });
    // The fleet-size options under the stage filter only.
    expect(
      searchMeta.facets.fleet_size.find((option) => option.value === "1-5")
        ?.count,
    ).toBe(2);
    expect(
      searchMeta.facets.fleet_size.find((option) => option.value === "101+")
        ?.count,
    ).toBe(0);
  });
});

describe("the twin's update writes what the use case decided", () => {
  it("keeps contacted_at when a contacted quote converts, as the database does", async () => {
    const update = new UpdateQuoteStatusUseCase(users, repository);
    const contacted = repository.quotes.find(
      (quote) => quote.name === "Pessoa Q03",
    )!;
    const before = contacted.contacted_at;

    const converted = await update.execute({
      quoteId: contacted.id,
      status: "CONVERTED",
      userId: "master",
    });

    // The twin used to clear it on CONVERTED; the repository never did.
    expect(converted.status).toBe("CONVERTED");
    expect(converted.contacted_at).toEqual(before);
  });

  it("raises P2025 for a quote that is not there", async () => {
    await expect(
      repository.updateQuoteStatus({
        quoteId: "missing",
        quoteData: { status: "CLOSED" },
      }),
    ).rejects.toMatchObject({ code: "P2025" });
    await expect(repository.deleteQuote("missing")).rejects.toMatchObject({
      code: "P2025",
    });
  });
});
