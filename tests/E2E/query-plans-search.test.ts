import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { DeliveryRepository } from "@/modules/delivery/repositories/delivery-repository";
import { SEARCH_PREFILTER_CAP } from "@/modules/delivery/repositories/delivery-search";
import { deliveryListWhere } from "@/modules/delivery/usecases/list-delivery/delivery-list";

/**
 * The deliveries search through the trigram index (delivery-search.ts,
 * migration 20261007120100_delivery_search_trgm), against the real database.
 *
 * Two promises. It finds exactly what the ILIKE search found — every column,
 * the driver's name and CNH, % taken literally, nothing that spans two
 * columns, nothing of another company — which is checked against the ILIKE
 * `where` itself. And with a selective term the page and its three counts
 * read the matching rows, not the company's history (db-perf 10/2026:
 * 1.3 s -> about 100 ms per keystroke for a company with 300k deliveries).
 */
const prisma = new PrismaClient();

const capture = new PrismaClient({ log: [{ emit: "event", level: "query" }] });
const sent: Array<{ query: string; params: string }> = [];

capture.$on("query", (event) => {
  sent.push({ query: event.query, params: event.params });
});

const CARRIER = randomUUID();
const OTHER = randomUUID();

const DRIVER = randomUUID();

/** A driver with more deliveries than the prefilter cap, as any real driver soon has. */
const PROLIFIC_DRIVER = randomUUID();
const PROLIFIC_DELIVERIES = 1_500;

const CRAFTED = {
  maria: randomUUID(),
  carlos: randomUUID(),
  percent: randomUUID(),
  ana: randomUUID(),
};

const INVOICE_KEY = "35191001234567000189550010000123451000123450";

/** Enough rows that reading the company is visibly more than reading the matches. */
const VOLUME = 20_000;

async function createBusiness(id: string) {
  await prisma.business.create({
    data: {
      id,
      corporate_reason: `Busca ${id.slice(0, 8)}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(54000000000000 + Math.floor(Math.random() * 9_000_000_000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `busca-${randomUUID()}@exemplo.com.br`,
    },
  });
}

let shipperOf: Record<string, string> = {};

beforeAll(async () => {
  await createBusiness(CARRIER);
  await createBusiness(OTHER);

  shipperOf = {};

  for (const businessId of [CARRIER, OTHER]) {
    const shipper = await prisma.shipper.create({
      data: { name: "Embarcador", businessId },
    });
    shipperOf[businessId] = shipper.id;
  }

  await prisma.driver.create({
    data: {
      id: DRIVER,
      name: "João Batista",
      birth_date: new Date("1985-01-01"),
      cnh: "98765432100",
      cpf: "52998224725",
      rg: "RG",
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

  await prisma.driver.create({
    data: {
      id: PROLIFIC_DRIVER,
      name: "Severino Prolífico",
      birth_date: new Date("1980-01-01"),
      cnh: "55544433322",
      cpf: "11144477735",
      rg: "RG",
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

  const crafted = (
    id: string,
    data: {
      recipient_name: string;
      city: string;
      code?: string;
      invoice_number?: string;
      invoice_key?: string;
      driverId?: string;
    },
    businessId = CARRIER,
  ) => ({
    id,
    street: "Rua",
    uf: "SP",
    status: "PENDING" as const,
    businessId,
    shipperId: shipperOf[businessId],
    ...data,
  });

  await prisma.delivery.createMany({
    data: [
      crafted(CRAFTED.maria, {
        recipient_name: "Maria Aparecida",
        city: "Campinas",
        code: "PED-777",
        invoice_number: "NFX4455",
        invoice_key: INVOICE_KEY,
        driverId: DRIVER,
      }),
      crafted(CRAFTED.carlos, {
        recipient_name: "Carlos Souza",
        city: "Santos",
      }),
      crafted(CRAFTED.percent, {
        recipient_name: "Desconto 50% Ltda",
        city: "Sorocaba",
      }),
      crafted(CRAFTED.ana, { recipient_name: "Ana", city: "Paulínia" }),
      // The same recipient in another company: never a result here.
      crafted(
        randomUUID(),
        {
          recipient_name: "Maria Aparecida",
          city: "Campinas",
          code: "PED-777",
        },
        OTHER,
      ),
    ],
  });

  // Volume in both companies, interleaved in id order.
  await prisma.$executeRawUnsafe(
    `INSERT INTO delivery (id, recipient_name, city, uf, street, status, "businessId", "shipperId", kind, created_at, updated_at)
     SELECT gen_random_uuid()::text, 'Cliente ' || n, 'Ribeirão Preto', 'SP', 'Rua ' || n,
            (ARRAY['PENDING','IN_TRANSIT','DELIVERED','FAILED','CANCELLED'])[1 + n % 5]::"DeliveryStatus",
            c.b, c.s, 'DELIVERY', now() - (n || ' minutes')::interval, now()
     FROM (VALUES ($1, $2), ($3, $4)) AS c(b, s), generate_series(1, ${VOLUME}) n`,
    CARRIER,
    shipperOf[CARRIER],
    OTHER,
    shipperOf[OTHER],
  );

  // The prolific driver's history: text that no other case's term matches.
  await prisma.$executeRawUnsafe(
    `INSERT INTO delivery (id, recipient_name, city, uf, street, status, "businessId", "shipperId", "driverId", kind, created_at, updated_at)
     SELECT gen_random_uuid()::text, 'Loja ' || n, 'Franca', 'SP', 'Rua ' || n, 'DELIVERED'::"DeliveryStatus",
            $1, $2, $3, 'DELIVERY', now() - (n || ' hours')::interval, now()
     FROM generate_series(1, ${PROLIFIC_DELIVERIES}) n`,
    CARRIER,
    shipperOf[CARRIER],
    PROLIFIC_DRIVER,
  );

  await prisma.$executeRawUnsafe(`VACUUM (ANALYZE) "delivery"`);
}, 300_000);

afterAll(async () => {
  await capture.$disconnect();
  await prisma.$disconnect();
});

/** What the ILIKE `where` (the search as it always was) finds in the company. */
async function ilikeMatches(search: string): Promise<string[]> {
  const rows = await prisma.delivery.findMany({
    where: deliveryListWhere({ businessId: CARRIER, search }),
    select: { id: true },
  });

  return rows.map((row) => row.id).sort();
}

async function listed(search: string) {
  sent.length = 0;

  const page = await new DeliveryRepository(capture).listDeliveries({
    businessId: CARRIER,
    page: 1,
    pageSize: 100,
    search,
  } as never);

  return {
    ids: page.data.map((delivery) => delivery.id).sort(),
    statusTotal: page.statusCounts.reduce((sum, entry) => sum + entry.count, 0),
    statements: [...sent],
  };
}

describe("the search finds exactly what the ILIKE search found", () => {
  const cases: Array<[string, () => string, string[]]> = [
    ["the recipient, in any case", () => "aparecida", [CRAFTED.maria]],
    ["the order code", () => "PED-777", [CRAFTED.maria]],
    ["the NF-e number", () => "x4455", [CRAFTED.maria]],
    [
      "a slice of the NF-e key",
      () => INVOICE_KEY.slice(10, 22),
      [CRAFTED.maria],
    ],
    ["a slice of the id", () => CRAFTED.carlos.slice(0, 13), [CRAFTED.carlos]],
    ["the city", () => "CAMPINAS", [CRAFTED.maria]],
    ["the driver's name", () => "joão bat", [CRAFTED.maria]],
    ["the driver's CNH", () => "876543210", [CRAFTED.maria]],
    ["a % taken literally", () => "50%", [CRAFTED.percent]],
    ["nothing that spans two columns", () => "idaCamp", []],
    ["a three-letter word", () => "Ana", [CRAFTED.ana]],
    ["a short term, on the ILIKE path", () => "Sa", [CRAFTED.carlos]],
  ];

  for (const [name, term, expected] of cases) {
    it(name, async () => {
      const result = await listed(term());

      expect(result.ids).toEqual([...expected].sort());
      // The same rows the ILIKE where finds, and the cards add up to them.
      expect(result.ids).toEqual(await ilikeMatches(term()));
      expect(result.statusTotal).toBe(expected.length);
    });
  }

  it("and, for a driver's token, only that driver's deliveries", async () => {
    const asDriver = (search: string) =>
      new DeliveryRepository(capture).listDeliveries({
        businessId: CARRIER,
        scopeDriverId: DRIVER,
        page: 1,
        pageSize: 100,
        search,
      } as never);

    expect(
      (await asDriver("Campinas")).data.map((delivery) => delivery.id),
    ).toEqual([CRAFTED.maria]);
    expect((await asDriver("Santos")).data).toEqual([]);
  });

  it("and keeps to the caller's company even when the other has the same text", async () => {
    const result = await listed("Maria Aparecida");

    expect(result.ids).toEqual([CRAFTED.maria]);
  });

  it("a term in more rows than the cap falls back to the ILIKE search, with the right totals", async () => {
    const result = await listed("Cliente");

    expect(VOLUME).toBeGreaterThan(SEARCH_PREFILTER_CAP);
    expect(result.statusTotal).toBe(VOLUME);
    expect(
      result.statements.some(
        (statement) =>
          /ILIKE/.test(statement.query) && /GROUP BY/.test(statement.query),
      ),
    ).toBe(true);
  });
});

describe("with a selective term", () => {
  interface PlanNode {
    "Node Type": string;
    "Relation Name"?: string;
    "Actual Rows"?: number;
    "Actual Loops"?: number;
    "Rows Removed by Filter"?: number;
    Plans?: PlanNode[];
  }

  const flatten = (node: PlanNode): PlanNode[] => [
    node,
    ...(node.Plans ?? []).flatMap(flatten),
  ];

  async function rowsTouched(statement: {
    query: string;
    params: string;
  }): Promise<number> {
    const rows = await prisma.$queryRawUnsafe<{ "QUERY PLAN": unknown }[]>(
      `EXPLAIN (ANALYZE, FORMAT JSON) ${statement.query}`,
      ...(JSON.parse(statement.params) as unknown[]),
    );

    const raw = rows[0]["QUERY PLAN"];
    const plan = (
      (typeof raw === "string" ? JSON.parse(raw) : raw) as Array<{
        Plan: PlanNode;
      }>
    )[0].Plan;

    return flatten(plan)
      .filter((node) => node["Relation Name"] === "delivery")
      .reduce(
        (sum, node) =>
          sum +
          ((node["Actual Rows"] ?? 0) + (node["Rows Removed by Filter"] ?? 0)) *
            (node["Actual Loops"] ?? 1),
        0,
      );
  }

  it("the page and its three counts read the matches, not the company's deliveries", async () => {
    // "Cliente 4242": one of twenty thousand.
    const result = await listed("Cliente 4242");

    expect(result.statusTotal).toBe(1);

    const listing = result.statements.filter(
      (statement) =>
        /FROM "public"\."delivery"/.test(statement.query) &&
        /(GROUP BY|ORDER BY)/.test(statement.query),
    );

    // The page and the status, shipper and driver counts.
    expect(listing.length).toBeGreaterThanOrEqual(4);

    for (const statement of listing) {
      expect(
        await rowsTouched(statement),
        statement.query.slice(0, 160),
      ).toBeLessThan(100);
    }
  });

  it("a driver with more deliveries than the cap is still found through the index, not the ILIKE path", async () => {
    expect(PROLIFIC_DELIVERIES).toBeGreaterThan(SEARCH_PREFILTER_CAP);

    for (const term of ["Severino", "544433"]) {
      const result = await listed(term);

      // Every delivery of the driver, as the ILIKE search counts them.
      expect(result.statusTotal).toBe(PROLIFIC_DELIVERIES);
      expect((await ilikeMatches(term)).length).toBe(PROLIFIC_DELIVERIES);

      // No fallback: the counts never ran the ILIKE over the company.
      expect(
        result.statements.some(
          (statement) =>
            /ILIKE/.test(statement.query) && /GROUP BY/.test(statement.query),
        ),
      ).toBe(false);

      const listing = result.statements.filter(
        (statement) =>
          /FROM "public"\."delivery"/.test(statement.query) &&
          /(GROUP BY|ORDER BY)/.test(statement.query),
      );

      expect(listing.length).toBeGreaterThanOrEqual(4);

      // The driver's rows, not the company's (more than twenty thousand).
      for (const statement of listing) {
        expect(
          await rowsTouched(statement),
          statement.query.slice(0, 160),
        ).toBeLessThan(PROLIFIC_DELIVERIES * 2);
      }
    }
  });
});
