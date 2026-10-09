import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { sign } from "jsonwebtoken";

import { randomUUID } from "node:crypto";

import auth from "@/config/auth";

/**
 * The occurrence feed as the panel reads it, over real HTTP and Postgres:
 * order, filters and cards answered by the server for the whole company, not
 * for the ten rows a page holds (decision 8.8, the pilot of the list
 * contract). Plus the walls around it: another company's data, ids and
 * names never cross, and only who may read occurrences reads them.
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018fe100-0000-7000-8000-00000000000a";
const OTHER = "018fe100-0000-7000-8000-00000000000b";

const SHIPPER = "018fe100-0000-7000-8000-0000000000f1";
const OTHER_SHIPPER = "018fe100-0000-7000-8000-0000000000f2";

const DRIVER = "018fe100-0000-7000-8000-0000000000d1";

const AUSENTE = "018fe100-0000-7000-8000-0000000000e1";
const RECUSA = "018fe100-0000-7000-8000-0000000000e2";
const AVARIA = "018fe100-0000-7000-8000-0000000000e3";
const FOREIGN_TYPE = "018fe100-0000-7000-8000-0000000000e4";

const tokens: Record<
  "admin" | "readOnly" | "noOccurrences" | "driver" | "otherAdmin" | "master",
  string
> = {} as never;

let cnpjSeq = 0;

async function seedBusiness(id: string): Promise<void> {
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
      cnpj: String(31222555000180 + cnpjSeq),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `${id}@exemplo.com.br`,
    },
  });

  await prisma.businessEntitlement.create({
    data: { businessId: id, module: "DELIVERIES", enabled: true },
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

interface FeedLine {
  id: string;
  created_at: string;
  occurred_at: string | null;
  occurrenceType: { id: string; name: string; blocks_delivery: boolean };
  delivery: { recipient_name: string; status: string };
  reportedBy: { name: string };
}

interface FeedMeta {
  total: number;
  page: number;
  pageSize: number;
  searchMeta: {
    total: number;
    blocking: number;
    informational: number;
    facets: {
      severity: Array<{ value: string; count: number }>;
      occurrenceTypeId: Array<{ value: string; label?: string; count: number }>;
    };
  };
}

async function feed(
  query: string,
  token = tokens.admin,
  page = 1,
): Promise<{ status: number; meta: FeedMeta; rows: FeedLine[]; body: string }> {
  const response = await app.inject({
    method: "GET",
    url: `/delivery/list-occurrences?page=${page}&pageSize=10${query ? `&${query}` : ""}`,
    headers: { authorization: `Bearer ${token}` },
  });

  if (response.statusCode !== 200) {
    return { status: response.statusCode, meta: {} as FeedMeta, rows: [], body: response.body };
  }

  const [first, ...rest] = response.body
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  return { status: 200, meta: first.meta, rows: rest, body: response.body };
}

const recipients = (rows: FeedLine[]) => rows.map((row) => row.delivery.recipient_name);

/** Both pages of the twelve, in the order the server streamed them. */
async function bothPages(query: string): Promise<FeedLine[]> {
  const first = await feed(query);
  const second = await feed(query, tokens.admin, 2);

  return [...first.rows, ...second.rows];
}

/**
 * Twelve occurrences, more than one page of ten, so a sort or a filter that
 * only looked at the loaded page would give itself away.
 *
 * Recipients R00..R11, oldest first (R11 is the newest). By index modulo 3:
 * 0 "Recusa" and 2 "Avaria" (both blocking), 1 "Destinatário ausente"
 * (informational). By index modulo 4: 0 FAILED, 1 DELIVERED, else IN_TRANSIT.
 * Even indexes were reported by Zélia, odd ones by Abel.
 *
 * Two traps for the order:
 * - Two pairs arrived in the same instant, so only the id tiebreaker orders
 *   them. Without it Postgres may hand equal rows back in any order, often
 *   the physical (insertion) order or its reverse, and a single pair agrees
 *   with one of those in one direction by luck. Rows are inserted by index:
 *   R04 (first in) has the LARGER id, so `id desc` matches insertion order;
 *   R07 (first in) has the SMALLER id, so `id desc` reverses it. Whatever
 *   order a plan falls back to, one of the pairs contradicts it in each
 *   direction.
 * - R11 was written offline three days before it arrived: the newest by
 *   created_at, the oldest by occurred_at.
 */
const TIE_R04 = "018fe100-0000-7000-8000-0000000009f4";
const TIE_R05 = "018fe100-0000-7000-8000-0000000001f5";
const TIE_R07 = "018fe100-0000-7000-8000-000000000107";
const TIE_R08 = "018fe100-0000-7000-8000-000000000908";

const TIE_IDS: Record<number, string> = {
  4: TIE_R04,
  5: TIE_R05,
  7: TIE_R07,
  8: TIE_R08,
};

/** Minutes before now each tie pair arrived (R04's and R07's instants). */
const TIE_MINUTES: Record<number, number> = { 5: 100, 8: 85 };

const OFFLINE_DAYS = 3;

const SEED = Array.from({ length: 12 }, (_, index) => {
  const typeId =
    index % 3 === 0 ? RECUSA : index % 3 === 1 ? AUSENTE : AVARIA;
  const status = index % 4 === 0 ? "FAILED" : index % 4 === 1 ? "DELIVERED" : "IN_TRANSIT";

  return {
    recipient: `R${String(index).padStart(2, "0")}`,
    typeId,
    status: status as "FAILED" | "DELIVERED" | "IN_TRANSIT",
    // R05 shares R04's instant and R08 shares R07's (see above).
    minutesAgo: TIE_MINUTES[index] ?? 120 - index * 5,
    id: TIE_IDS[index],
    offline: index === 11,
  };
});

const BLOCKING_TYPES = new Set([RECUSA, AVARIA]);

beforeAll(async () => {
  await seedBusiness(CARRIER);
  await seedBusiness(OTHER);

  await prisma.shipper.createMany({
    data: [
      { id: SHIPPER, name: "Embarcador", businessId: CARRIER },
      { id: OTHER_SHIPPER, name: "Embarcador alheio", businessId: OTHER },
    ],
  });

  await prisma.occurrenceType.createMany({
    data: [
      { id: AUSENTE, name: "Destinatário ausente", blocks_delivery: false, businessId: CARRIER },
      { id: RECUSA, name: "Recusa", blocks_delivery: true, businessId: CARRIER },
      { id: AVARIA, name: "Avaria", blocks_delivery: true, businessId: CARRIER },
      { id: FOREIGN_TYPE, name: "Tipo secreto alheio", blocks_delivery: true, businessId: OTHER },
    ],
  });

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
  const reporter = await seedUser("Abel Relator", "BUSINESS_ADMIN", CARRIER);

  tokens.admin = admin.token;

  tokens.readOnly = (
    await seedUser("Leitura", "BUSINESS_USER", CARRIER, {
      profileAccessId: await seedProfile(CARRIER, "occurrence_manage", false),
    })
  ).token;

  tokens.noOccurrences = (
    await seedUser("Despacho", "BUSINESS_USER", CARRIER, {
      profileAccessId: await seedProfile(CARRIER, "delivery_manage", true),
    })
  ).token;

  tokens.driver = (
    await seedUser("Motorista", "BUSINESS_USER", CARRIER, { driverId: DRIVER })
  ).token;

  tokens.otherAdmin = (await seedUser("Outro", "BUSINESS_ADMIN", OTHER)).token;
  tokens.master = (await seedUser("Master", "MASTER", null)).token;

  const now = Date.now();

  for (const [index, entry] of SEED.entries()) {
    const delivery = await prisma.delivery.create({
      data: {
        recipient_name: entry.recipient,
        city: "São Paulo",
        uf: "SP",
        street: "Praça da Sé",
        status: entry.status,
        businessId: CARRIER,
        shipperId: SHIPPER,
      },
    });

    await prisma.deliveryOccurrence.create({
      data: {
        ...(entry.id && { id: entry.id }),
        deliveryId: delivery.id,
        businessId: CARRIER,
        occurrenceTypeId: entry.typeId,
        // Half by each, so the reporter sort has something to order.
        reportedById: index % 2 === 0 ? admin.id : reporter.id,
        created_at: new Date(now - entry.minutesAgo * 60_000),
        ...(entry.offline && {
          occurred_at: new Date(now - OFFLINE_DAYS * 24 * 60 * 60_000),
        }),
      },
    });
  }

  // Another company's occurrence, on a type whose name must never show up.
  const foreign = await prisma.delivery.create({
    data: {
      recipient_name: "R99 de outra empresa",
      city: "Rio de Janeiro",
      uf: "RJ",
      street: "Avenida Atlântica",
      status: "FAILED",
      businessId: OTHER,
      shipperId: OTHER_SHIPPER,
    },
  });

  const otherUser = await prisma.user.findFirstOrThrow({ where: { businessId: OTHER } });

  await prisma.deliveryOccurrence.create({
    data: {
      deliveryId: foreign.id,
      businessId: OTHER,
      occurrenceTypeId: FOREIGN_TYPE,
      reportedById: otherUser.id,
    },
  });

  ({ app } = await import("@/http"));
  await app.ready();
}, 90_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

describe("GET /delivery/list-occurrences — order", () => {
  it("defaults to newest first over the whole company", async () => {
    const { status, meta, rows } = await feed("");

    expect(status).toBe(200);
    expect(meta.total).toBe(12);
    // Each tie pair larger id first (the id desc tiebreaker): R04 before
    // R05, R08 before R07.
    expect(recipients(rows)).toEqual(
      ["R11", "R10", "R09", "R08", "R07", "R06", "R04", "R05", "R03", "R02"],
    );
  });

  it("breaks a tie on the date by id, the same way on every request", async () => {
    const desc = recipients(await bothPages("sort=created_at&order=desc"));
    const asc = recipients(await bothPages("sort=created_at&order=asc"));

    // The date runs both ways; the tiebreaker stays id desc. R04/R05 follow
    // insertion order and R08/R07 reverse it, so neither direction can pass
    // on a plan's physical order.
    for (const rows of [desc, asc]) {
      expect(rows.indexOf("R04")).toBe(rows.indexOf("R05") - 1);
      expect(rows.indexOf("R08")).toBe(rows.indexOf("R07") - 1);
    }
  });

  it("orders the date column by arrival, the instant it shows, offline reports included", async () => {
    for (const order of ["desc", "asc"] as const) {
      const rows = await bothPages(`sort=created_at&order=${order}`);
      const arrivals = rows.map((row) => Date.parse(row.created_at));

      expect(rows).toHaveLength(12);
      expect(arrivals).toEqual(
        [...arrivals].sort((a, b) => (order === "asc" ? a - b : b - a)),
      );

      // R11 was written three days before anything else arrived, and still
      // sorts as the newest: occurred_at is not the key.
      const offline = rows.find((row) => row.delivery.recipient_name === "R11")!;

      expect(Date.parse(offline.occurred_at!)).toBeLessThan(Math.min(...arrivals));
      expect(rows.indexOf(offline)).toBe(order === "desc" ? 0 : 11);
    }
  });

  it("sorts ascending by date across pages, not inside one", async () => {
    const first = await feed("sort=created_at&order=asc");

    expect(recipients(first.rows).slice(0, 3)).toEqual(["R00", "R01", "R02"]);

    const second = await app.inject({
      method: "GET",
      url: "/delivery/list-occurrences?page=2&pageSize=10&sort=created_at&order=asc",
      headers: { authorization: `Bearer ${tokens.admin}` },
    });

    const secondRows = second.body.trim().split("\n").slice(1).map((line) => JSON.parse(line));

    expect(recipients(secondRows)).toEqual(["R10", "R11"]);
  });

  it("sorts by recipient, both ways", async () => {
    const asc = await feed("sort=recipient&order=asc");
    const desc = await feed("sort=recipient&order=desc");

    expect(recipients(asc.rows)[0]).toBe("R00");
    expect(recipients(desc.rows)[0]).toBe("R11");
  });

  it("sorts by type name across pages, newest first inside a type", async () => {
    // Avaria (2, 5, 8, 11), Destinatário ausente (1, 4, 7, 10), Recusa
    // (0, 3, 6, 9); newest first inside each. Page two continues the last.
    expect(recipients(await bothPages("sort=typeName&order=asc"))).toEqual([
      "R11", "R08", "R05", "R02",
      "R10", "R07", "R04", "R01",
      "R09", "R06",
      "R03", "R00",
    ]);

    expect(recipients(await bothPages("sort=typeName&order=desc"))).toEqual([
      "R09", "R06", "R03", "R00",
      "R10", "R07", "R04", "R01",
      "R11", "R08",
      "R05", "R02",
    ]);
  });

  it("sorts by severity both ways across pages", async () => {
    // Informational first on asc (false before true), newest first inside.
    expect(recipients(await bothPages("sort=blocking&order=asc"))).toEqual([
      "R10", "R07", "R04", "R01",
      "R11", "R09", "R08", "R06", "R05", "R03",
      "R02", "R00",
    ]);

    expect(recipients(await bothPages("sort=blocking&order=desc"))).toEqual([
      "R11", "R09", "R08", "R06", "R05", "R03", "R02", "R00",
      "R10", "R07",
      "R04", "R01",
    ]);
  });

  it("sorts by who reported", async () => {
    const { rows } = await feed("sort=reporter&order=asc");

    // Six by Abel, then Zélia's.
    expect(rows.slice(0, 6).every((row) => row.reportedBy.name === "Abel Relator")).toBe(true);
    expect(rows[6].reportedBy.name).toBe("Zélia Gestora");

    const desc = await feed("sort=reporter&order=desc");

    expect(desc.rows[0].reportedBy.name).toBe("Zélia Gestora");
  });

  it("refuses a column the list does not order by", async () => {
    const { status, body } = await feed("sort=description");

    expect(status).toBe(400);
    expect(body).toContain("Ordenação inválida");
  });
});

describe("GET /delivery/list-occurrences — filters and cards", () => {
  it("filters by severity over the whole company and keeps the cards whole", async () => {
    const { meta, rows } = await feed("severity=blocking");

    const blockingSeeded = SEED.filter((entry) => BLOCKING_TYPES.has(entry.typeId)).length;

    expect(meta.total).toBe(blockingSeeded);
    expect(rows.every((row) => row.occurrenceType.blocks_delivery)).toBe(true);

    expect(meta.searchMeta).toMatchObject({
      total: 12,
      blocking: blockingSeeded,
      informational: 12 - blockingSeeded,
    });
  });

  it("filters by several types, and counts the type options without that filter", async () => {
    const { meta, rows } = await feed(`occurrenceTypeId=${RECUSA},${AVARIA}`);

    expect(meta.total).toBe(8);
    expect(new Set(rows.map((row) => row.occurrenceType.id))).toEqual(
      new Set([RECUSA, AVARIA]),
    );

    expect(meta.searchMeta.facets.occurrenceTypeId).toEqual([
      { value: AVARIA, label: "Avaria", count: 4 },
      { value: AUSENTE, label: "Destinatário ausente", count: 4 },
      { value: RECUSA, label: "Recusa", count: 4 },
    ]);

    // The cards follow the type filter: everything left is blocking.
    expect(meta.searchMeta).toMatchObject({ total: 8, blocking: 8, informational: 0 });
  });

  it("filters by delivery status, in the comma and the repeated form alike", async () => {
    const expected = SEED.filter((entry) => entry.status !== "IN_TRANSIT").length;

    const comma = await feed("deliveryStatus=FAILED,DELIVERED");
    const repeated = await feed("deliveryStatus=FAILED&deliveryStatus=DELIVERED");

    expect(comma.meta.total).toBe(expected);
    expect(repeated.meta.total).toBe(expected);
    expect(comma.rows.every((row) => row.delivery.status !== "IN_TRANSIT")).toBe(true);
  });

  it("combines search, facets and sort", async () => {
    const { meta, rows } = await feed(
      "search=recusa&deliveryStatus=FAILED,IN_TRANSIT&sort=recipient&order=desc",
    );

    const expected = SEED.filter(
      (entry) => entry.typeId === RECUSA && entry.status !== "DELIVERED",
    )
      .map((entry) => entry.recipient)
      .sort()
      .reverse();

    expect(recipients(rows)).toEqual(expected);
    expect(meta.total).toBe(expected.length);
  });

  it("refuses a filter value outside the set and an id that is not one", async () => {
    expect((await feed("severity=critical")).status).toBe(400);
    expect((await feed("deliveryStatus=LOST")).status).toBe(400);
    expect((await feed("occurrenceTypeId=abc")).status).toBe(400);
  });
});

describe("GET /delivery/list-occurrences — tenant and roles", () => {
  it("never lists, counts or names another company's occurrences", async () => {
    const { meta, rows, body } = await feed("");

    expect(rows.some((row) => row.delivery.recipient_name.startsWith("R99"))).toBe(false);
    expect(meta.searchMeta.total).toBe(12);
    expect(body).not.toContain("Tipo secreto alheio");
  });

  it("answers a foreign type id with nothing, not with its name", async () => {
    const { meta, rows, body } = await feed(`occurrenceTypeId=${FOREIGN_TYPE}`);

    expect(rows).toHaveLength(0);
    expect(meta.total).toBe(0);
    expect(body).not.toContain("Tipo secreto alheio");
    expect(
      meta.searchMeta.facets.occurrenceTypeId.some((option) => option.value === FOREIGN_TYPE),
    ).toBe(false);
  });

  it("refuses a manager naming another company", async () => {
    const { status } = await feed(`businessId=${CARRIER}`, tokens.otherAdmin);

    expect(status).toBe(403);
  });

  it("gives the other company only its own feed", async () => {
    const { meta, rows } = await feed("", tokens.otherAdmin);

    expect(meta.total).toBe(1);
    expect(recipients(rows)).toEqual(["R99 de outra empresa"]);
  });

  it("lets a master read the company it picks, filtered on the server", async () => {
    const { status, meta } = await feed(
      `businessId=${CARRIER}&severity=informational`,
      tokens.master,
    );

    expect(status).toBe(200);
    expect(meta.total).toBe(SEED.filter((entry) => entry.typeId === AUSENTE).length);
  });

  it("asks a master to pick a company", async () => {
    const { status, body } = await feed("", tokens.master);

    expect(status).toBe(400);
    expect(body).toContain("BUSINESS_NOT_IDENTIFIED");
  });

  it("serves a read-only profile", async () => {
    expect((await feed("sort=recipient&order=asc", tokens.readOnly)).status).toBe(200);
  });

  it("refuses a profile without the occurrence permission and a driver", async () => {
    expect((await feed("", tokens.noOccurrences)).status).toBe(403);
    expect((await feed("", tokens.driver)).status).toBe(403);
  });
});
