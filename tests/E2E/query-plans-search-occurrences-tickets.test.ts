import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { SupportTicketRepository } from "@/modules/chat/repositories/support-ticket-repository";
import { DeliveryRepository } from "@/modules/delivery/repositories/delivery-repository";
import { SEARCH_PREFILTER_CAP } from "@/modules/delivery/repositories/delivery-search";
import { occurrenceFeedWhere } from "@/modules/delivery/usecases/list-occurrences/occurrence-feed";

/**
 * The occurrence feed's search and the support inbox's search through the
 * deliveries' trigram index (occurrence-search.ts and
 * SupportTicketRepository.resolveSearchMatches; docs/desempenho/banco-2026-10.md
 * §9, limit 3), against the real database.
 *
 * Two promises, as for the deliveries' search. Exactly the rows the joined
 * ILIKE search found — checked against that `where` itself, term by term,
 * including a code or a city that is in the indexed text but not a searched
 * column, a literal %, and the same text in another company. And with a
 * selective term the page and its counts no longer join the recipient or the
 * type/driver name for every row of the company.
 */
const prisma = new PrismaClient();

const capture = new PrismaClient({ log: [{ emit: "event", level: "query" }] });
const sent: Array<{ query: string; params: string }> = [];

capture.$on("query", (event) => {
  sent.push({ query: event.query, params: event.params });
});

const CARRIER = randomUUID();
const OTHER = randomUUID();

/** More recipients named "Cliente …" than the cap: the common-term fallback. */
const VOLUME = SEARCH_PREFILTER_CAP + 200;

const ids = {
  user: {} as Record<string, string>,
  driver: {} as Record<string, string>,
  thread: {} as Record<string, string>,
  type: {} as Record<string, Record<string, string>>,
  delivery: {} as Record<string, Record<string, string>>,
  occurrence: {} as Record<string, Record<string, string>>,
};

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
      cnpj: String(55000000000000 + Math.floor(Math.random() * 9_000_000_000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `busca-occ-${randomUUID()}@exemplo.com.br`,
    },
  });
}

async function seedCompany(businessId: string) {
  const shipper = await prisma.shipper.create({
    data: { name: "Embarcador", businessId },
  });

  const user = await prisma.user.create({
    data: {
      name: "Despacho",
      email: `despacho-${randomUUID()}@exemplo.com.br`,
      password: "nao-usado",
      role: "BUSINESS_ADMIN",
      businessId,
    },
  });
  ids.user[businessId] = user.id;

  const driver = await prisma.driver.create({
    data: {
      name: "Josué Motorista",
      birth_date: new Date("1985-01-01"),
      cnh: String(10000000000 + Math.floor(Math.random() * 8_999_999_999)),
      cpf: String(10000000000 + Math.floor(Math.random() * 8_999_999_999)),
      rg: "RG",
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
  ids.driver[businessId] = driver.id;

  const thread = await prisma.chatThread.create({
    data: { businessId, driverId: driver.id },
  });
  ids.thread[businessId] = thread.id;

  const types: Record<string, string> = {};

  for (const name of [
    "Avaria na carga",
    "Cliente ausente",
    "Endereço não localizado",
  ]) {
    types[name] = (
      await prisma.occurrenceType.create({
        data: { name, businessId, category: "NOT_DELIVERED" },
      })
    ).id;
  }
  ids.type[businessId] = types;

  const crafted: Record<
    string,
    { recipient_name: string; city: string; code?: string; type: string }
  > = {
    maria: {
      recipient_name: "Maria Aparecida",
      city: "Campinas",
      code: "PED-777",
      type: "Avaria na carga",
    },
    percent: {
      recipient_name: "Desconto 50% Ltda",
      city: "Santos",
      type: "Endereço não localizado",
    },
    underscore: {
      recipient_name: "Loja_Um",
      city: "Sorocaba",
      type: "Endereço não localizado",
    },
    accent: {
      recipient_name: "José Ávila",
      city: "Jundiaí",
      type: "Endereço não localizado",
    },
  };

  const deliveries: Record<string, string> = {};
  const occurrences: Record<string, string> = {};

  for (const [key, data] of Object.entries(crafted)) {
    const delivery = await prisma.delivery.create({
      data: {
        street: "Rua",
        uf: "SP",
        status: "PENDING",
        businessId,
        shipperId: shipper.id,
        recipient_name: data.recipient_name,
        city: data.city,
        ...(data.code && { code: data.code }),
      },
    });
    deliveries[key] = delivery.id;

    const occurrence = await prisma.deliveryOccurrence.create({
      data: {
        deliveryId: delivery.id,
        businessId,
        occurrenceTypeId: types[data.type],
        reportedById: user.id,
      },
    });
    occurrences[key] = occurrence.id;

    await prisma.supportTicket.create({
      data: {
        number: Object.keys(occurrences).length,
        kind: "OCCURRENCE",
        subject: `Ocorrência ${key}`,
        businessId,
        threadId: thread.id,
        driverId: driver.id,
        deliveryId: delivery.id,
        occurrenceId: occurrence.id,
        opened_via: "PANEL",
      },
    });
  }

  // The volume: a common recipient word, past the cap.
  const bulkIds = Array.from({ length: VOLUME }, () => randomUUID());

  await prisma.delivery.createMany({
    data: bulkIds.map((id, index) => ({
      id,
      street: "Rua",
      uf: "SP",
      status: "PENDING" as const,
      businessId,
      shipperId: shipper.id,
      recipient_name: `Cliente ${index}`,
      city: "Ribeirão Preto",
    })),
  });

  await prisma.deliveryOccurrence.createMany({
    data: bulkIds.map((deliveryId, index) => ({
      deliveryId,
      businessId,
      occurrenceTypeId:
        index % 2 === 0
          ? types["Cliente ausente"]
          : types["Endereço não localizado"],
      reportedById: user.id,
    })),
  });

  ids.delivery[businessId] = deliveries;
  ids.occurrence[businessId] = occurrences;
}

beforeAll(async () => {
  await createBusiness(CARRIER);
  await createBusiness(OTHER);
  await seedCompany(CARRIER);
  await seedCompany(OTHER);
  await prisma.$executeRawUnsafe(`ANALYZE "delivery"`);
  await prisma.$executeRawUnsafe(`ANALYZE "delivery_occurrence"`);
}, 120_000);

afterAll(async () => {
  for (const businessId of [CARRIER, OTHER]) {
    await prisma.supportTicket.deleteMany({ where: { businessId } });
    await prisma.deliveryOccurrence.deleteMany({ where: { businessId } });
    await prisma.delivery.deleteMany({ where: { businessId } });
    await prisma.occurrenceType.deleteMany({ where: { businessId } });
    await prisma.chatThread.deleteMany({ where: { businessId } });
    await prisma.driver.deleteMany({ where: { businessId } });
    await prisma.shipper.deleteMany({ where: { businessId } });
    await prisma.user.deleteMany({ where: { businessId } });
    await prisma.business.deleteMany({ where: { id: businessId } });
  }

  await prisma.$disconnect();
  await capture.$disconnect();
}, 120_000);

/** The terms, each with what the joined ILIKE search finds in CARRIER. */
const TERMS: Array<[string, () => string]> = [
  ["a recipient", () => "Maria Apar"],
  ["a recipient, other case", () => "maria aparecida"],
  ["a type name", () => "Avaria"],
  ["a type name and recipients", () => "Cliente aus"],
  ["a literal %", () => "50%"],
  ["a literal _", () => "a_U"],
  ["an accent", () => "José Á"],
  ["a code (indexed text, not a searched column)", () => "PED-777"],
  ["a city (indexed text, not a searched column)", () => "Campinas"],
  [
    "a piece of an occurrence id",
    () => ids.occurrence[CARRIER].maria.slice(9, 23),
  ],
  [
    "a piece of a delivery id",
    () => ids.delivery[CARRIER].percent.slice(14, 30),
  ],
  ["a short term", () => "Ma"],
  ["a common recipient (past the cap)", () => "Cliente"],
  ["nothing", () => "Zzyzx"],
];

async function occurrencesListed(search: string) {
  sent.length = 0;

  const result = await new DeliveryRepository(capture as never).listOccurrences(
    {
      businessId: CARRIER,
      search,
      page: 1,
      pageSize: VOLUME * 3,
    } as never,
  );

  return {
    ids: (result.data as Array<{ id: string }>).map((row) => row.id).sort(),
    total: result.typeCounts.reduce(
      (sum: number, type: { count: number }) => sum + type.count,
      0,
    ),
    statements: [...sent],
  };
}

async function occurrencesByJoinedSearch(search: string): Promise<string[]> {
  const rows = await prisma.deliveryOccurrence.findMany({
    where: occurrenceFeedWhere(
      { businessId: CARRIER, search },
      { withTypeFacets: true },
    ),
    select: { id: true },
  });

  return rows.map((row) => row.id).sort();
}

const ticketProps = (search: string) => ({
  businessId: CARRIER,
  requesterUserId: ids.user[CARRIER],
  status: "ALL" as const,
  scope: "ALL" as const,
  search,
  page: 1,
  pageSize: 500,
});

async function ticketsListed(search: string) {
  sent.length = 0;

  const result = await new SupportTicketRepository(capture as never).list(
    ticketProps(search) as never,
  );

  return {
    ids: result.data.map((row) => row.id).sort(),
    total: result.total,
    statements: [...sent],
  };
}

async function ticketsByJoinedSearch(search: string): Promise<string[]> {
  // The repository's own where with no resolved matches: the joined search.
  const repository = new SupportTicketRepository(
    prisma as never,
  ) as unknown as {
    listWhere(props: unknown, matches: null): object;
  };

  const rows = await prisma.supportTicket.findMany({
    where: repository.listWhere(ticketProps(search), null),
    select: { id: true },
  });

  return rows.map((row) => row.id).sort();
}

describe("the occurrence feed's search finds what the joined ILIKE search found", () => {
  for (const [label, term] of TERMS) {
    it(label, async () => {
      const expected = await occurrencesByJoinedSearch(term());
      const result = await occurrencesListed(term());

      expect(result.ids).toEqual(expected);
      expect(result.total).toBe(expected.length);
    });
  }

  it("the crafted cases match what they should, and nothing of the other company", async () => {
    const mine = ids.occurrence[CARRIER];

    expect((await occurrencesListed("Maria Apar")).ids).toEqual([mine.maria]);
    expect((await occurrencesListed("50%")).ids).toEqual([mine.percent]);
    expect((await occurrencesListed("Campinas")).ids).toEqual([]);
    expect((await occurrencesListed("PED-777")).ids).toEqual([]);
    expect((await occurrencesListed(ids.occurrence[OTHER].maria)).ids).toEqual(
      [],
    );
  });
});

describe("the support inbox's search finds what the joined ILIKE search found", () => {
  for (const [label, term] of [
    ...TERMS,
    ["a driver's name", () => "Josué"] as [string, () => string],
    ["a subject", () => "Ocorrência perc"] as [string, () => string],
  ]) {
    it(label, async () => {
      const expected = await ticketsByJoinedSearch(term());
      const result = await ticketsListed(term());

      expect(result.ids).toEqual(expected);
      expect(result.total).toBe(expected.length);
    });
  }

  it("a ticket number still finds its ticket", async () => {
    const result = await ticketsListed("#1");

    expect(result.ids).toEqual(await ticketsByJoinedSearch("#1"));
    expect(result.ids).toHaveLength(1);
  });
});

describe("with a selective term", () => {
  const onTable = (table: string) => (statement: { query: string }) =>
    new RegExp(`FROM "public"\\."${table}"`).test(statement.query);

  it("the feed's page and type counts no longer join the recipient or the type name", async () => {
    const result = await occurrencesListed("Maria Apar");

    const feed = result.statements.filter(onTable("delivery_occurrence"));

    // The page and the per-type counts.
    expect(feed.length).toBeGreaterThanOrEqual(2);

    for (const statement of feed) {
      expect(statement.query, statement.query.slice(0, 200)).not.toMatch(
        /recipient_name/,
      );
      expect(statement.query, statement.query.slice(0, 200)).not.toMatch(
        /"occurrence_type"\."name"/,
      );
    }

    // The recipient came from the trigram read, rechecked on the column.
    expect(
      result.statements.some(
        (statement) =>
          /chr\(31\)/.test(statement.query) &&
          /"recipient_name" ILIKE/.test(statement.query),
      ),
    ).toBe(true);
  });

  it("the inbox's page and total no longer join the recipient or the driver's name", async () => {
    const result = await ticketsListed("Maria Apar");

    const inbox = result.statements.filter(onTable("support_ticket"));

    expect(inbox.length).toBeGreaterThanOrEqual(2);

    for (const statement of inbox) {
      expect(statement.query, statement.query.slice(0, 200)).not.toMatch(
        /recipient_name/,
      );
      expect(statement.query, statement.query.slice(0, 200)).not.toMatch(
        /"driver"\."name"/,
      );
    }
  });

  it("a common term falls back to the joined search, with the same rows", async () => {
    const result = await occurrencesListed("Cliente");

    expect(result.total).toBeGreaterThan(SEARCH_PREFILTER_CAP);
    expect(
      result.statements
        .filter(onTable("delivery_occurrence"))
        .some((s) => /recipient_name/.test(s.query)),
    ).toBe(true);
  });
});
