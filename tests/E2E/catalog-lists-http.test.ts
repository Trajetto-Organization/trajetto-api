import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { sign } from "jsonwebtoken";

import { randomUUID } from "node:crypto";

import auth from "@/config/auth";

/**
 * The Entregas catalog tabs on the server (decision 8.8), over real HTTP and
 * Postgres: Embarcadores, Tipos de ocorrência, Motivos and Importações.
 *
 * Their Status/Impeditiva/Foto/Origem filters used to run over the ten rows
 * on screen, and their order was the page's own. What only the database can
 * vouch for is proven here: the `orderBy` with its tiebreaker across pages,
 * each filter's `where`, the GROUP BY behind the cards and the filter counts,
 * the 400s of the whitelist, the tenant and the roles.
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018fdd00-0000-7000-8000-00000000000a";
const OTHER = "018fdd00-0000-7000-8000-00000000000b";

const DRIVER = "018fdd00-0000-7000-8000-0000000000d1";

const tokens: Record<string, string> = {};

let cnpjSeq = 0;

async function seedBusiness(id: string): Promise<void> {
  cnpjSeq += 1;

  await prisma.business.create({
    data: {
      id,
      corporate_reason: `Transportadora ${id}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua das Transportadoras",
      address_number: "1",
      cnpj: String(44555666000100 + cnpjSeq),
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

async function seedUser(
  businessId: string | null,
  role: "MASTER" | "BUSINESS_ADMIN" | "BUSINESS_USER",
  extra: { driverId?: string; profileAccessId?: string } = {},
): Promise<string> {
  const id = randomUUID();
  const familyId = randomUUID();

  await prisma.user.create({
    data: {
      id,
      name: "Usuário",
      email: `${id}@exemplo.com.br`,
      password: "not-used-here",
      role,
      businessId,
      driverId: extra.driverId ?? null,
      profileAccessId: extra.profileAccessId ?? null,
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
    { subject: id, expiresIn: "15m" },
  );
}

/** A fixed id per row, so the tiebreaker's `id desc` is predictable. */
const idOf = (prefix: string, n: number) =>
  `018fdd00-0000-7000-8000-${prefix}${String(n).padStart(10, "0")}`;

const BASE_TIME = new Date("2026-09-01T12:00:00.000Z").getTime();

/** Twelve shippers, one minute apart, plus two same-instant pairs. */
const SHIPPERS = Array.from({ length: 12 }, (_, index) => ({
  id: idOf("5a", index + 1),
  name: `Shipper ${String.fromCharCode(65 + index)}`,
  created_at: new Date(BASE_TIME + index * 60_000),
  is_active: index % 4 !== 0,
  cnpj: index % 3 === 0 ? String(11222333000100 + index) : null,
}));

// Same created_at. Pair one: the row inserted first has the BIGGER id; pair
// two: the SMALLER. Without the id in the tiebreaker Postgres returns ties in
// any order, and one pair alone would agree with physical order by luck.
const TIE_AT = new Date(BASE_TIME - 24 * 60 * 60_000);

const TIE_PAIRS = [
  { id: idOf("5b", 9), name: "Tie One Big" },
  { id: idOf("5b", 1), name: "Tie One Small" },
  { id: idOf("5c", 1), name: "Tie Two Small" },
  { id: idOf("5c", 9), name: "Tie Two Big" },
];

function call(url: string, token: string) {
  return app.inject({
    method: "GET",
    url,
    headers: { authorization: `Bearer ${token}` },
  });
}

async function list(url: string, token = tokens.admin) {
  const response = await call(url, token);

  expect(response.statusCode, response.body.slice(0, 300)).toBe(200);

  const [head, ...lines] = response.body.split("\n").filter(Boolean);

  return {
    meta: JSON.parse(head).meta as {
      total: number;
      searchMeta: Record<string, any>;
    },
    rows: lines.map((line) => JSON.parse(line)) as Array<Record<string, any>>,
  };
}

beforeAll(async () => {
  await seedBusiness(CARRIER);
  await seedBusiness(OTHER);

  await prisma.driver.create({
    data: {
      id: DRIVER,
      name: "Motorista",
      birth_date: new Date("1990-01-01"),
      cnh: "66677788899",
      cpf: "66677788899-cpf",
      rg: "rg",
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

  // One at a time: the tie pairs must be inserted in the order written.
  for (const shipper of SHIPPERS) {
    await prisma.shipper.create({ data: { ...shipper, businessId: CARRIER } });
  }

  for (const shipper of TIE_PAIRS) {
    await prisma.shipper.create({
      data: { ...shipper, created_at: TIE_AT, businessId: CARRIER },
    });
  }

  await prisma.shipper.create({
    data: { name: "Shipper Alheio", businessId: OTHER, is_active: false },
  });

  // Tipos: every combination of impeditiva × foto, one inactive.
  const types = [
    { name: "Type Avaria", blocks_delivery: true, requires_photo: true },
    { name: "Type Recusa", blocks_delivery: true, requires_photo: false },
    { name: "Type Atraso", blocks_delivery: false, requires_photo: false },
    { name: "Type Portaria", blocks_delivery: false, requires_photo: true },
    {
      name: "Type Antigo",
      blocks_delivery: true,
      requires_photo: false,
      is_active: false,
    },
  ];

  for (const [index, type] of types.entries()) {
    await prisma.occurrenceType.create({
      data: {
        ...type,
        businessId: CARRIER,
        created_at: new Date(BASE_TIME + index * 60_000),
      },
    });
  }

  await prisma.occurrenceType.create({
    data: { name: "Type Alheio", businessId: OTHER, blocks_delivery: true },
  });

  // Motivos: one used by an event, one inactive.
  const used = await prisma.statusChangeReason.create({
    data: { name: "Reason Usado", businessId: CARRIER },
  });

  await prisma.statusChangeReason.create({
    data: { name: "Reason Livre", businessId: CARRIER },
  });

  await prisma.statusChangeReason.create({
    data: { name: "Reason Aposentado", businessId: CARRIER, is_active: false },
  });

  await prisma.statusChangeReason.create({
    data: { name: "Reason Alheio", businessId: OTHER },
  });

  const shipperForDelivery = SHIPPERS[1].id;

  const delivery = await prisma.delivery.create({
    data: {
      recipient_name: "Mercado",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      businessId: CARRIER,
      shipperId: shipperForDelivery,
    },
  });

  tokens.admin = await seedUser(CARRIER, "BUSINESS_ADMIN");

  const adminUser = await prisma.user.findFirstOrThrow({
    where: { businessId: CARRIER, role: "BUSINESS_ADMIN" },
  });

  await prisma.deliveryEvent.create({
    data: {
      type: "STATUS_CHANGE",
      deliveryId: delivery.id,
      businessId: CARRIER,
      reportedById: adminUser.id,
      actor: "USER",
      status_from: "PENDING",
      status_to: "CANCELLED",
      reasonId: used.id,
    },
  });

  // Importações: planilhas e XMLs, concluídas e estornadas.
  const uploads: Array<{
    source: "SPREADSHEET" | "NFE_XML";
    status: "IN_PROGRESS" | "COMPLETED" | "REVERSED";
    imported: number;
  }> = [
    { source: "SPREADSHEET", status: "COMPLETED", imported: 40 },
    { source: "SPREADSHEET", status: "REVERSED", imported: 5 },
    { source: "NFE_XML", status: "COMPLETED", imported: 12 },
    { source: "NFE_XML", status: "COMPLETED", imported: 3 },
  ];

  for (const [index, upload] of uploads.entries()) {
    await prisma.import.create({
      data: {
        ...upload,
        filename: `upload-${index}.csv`,
        report: {},
        businessId: CARRIER,
        performedById: adminUser.id,
        created_at: new Date(BASE_TIME + index * 60_000),
      },
    });
  }

  const readOnly = await prisma.profileAccess.create({
    data: { name: "Só leitura", businessId: CARRIER },
  });

  await prisma.permission.createMany({
    data: ["delivery_manage", "occurrence_manage"].map((key) => ({
      action: key,
      permissionKey: key,
      canRead: true,
      canWrite: false,
      profileAccessId: readOnly.id,
      businessId: CARRIER,
    })),
  });

  tokens.readOnly = await seedUser(CARRIER, "BUSINESS_USER", {
    profileAccessId: readOnly.id,
  });
  tokens.otherAdmin = await seedUser(OTHER, "BUSINESS_ADMIN");
  tokens.master = await seedUser(null, "MASTER");
  tokens.driver = await seedUser(CARRIER, "BUSINESS_USER", { driverId: DRIVER });

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

const SHIPPERS_URL = "/shipper/list-shipper?pageSize=10";

describe("the shippers table", () => {
  it("orders newest first by default and keeps the order across pages", async () => {
    const first = await list(`${SHIPPERS_URL}&page=1`);
    const second = await list(`${SHIPPERS_URL}&page=2`);

    const names = [...first.rows, ...second.rows].map((row) => row.name);

    expect(first.meta.total).toBe(16);
    expect(names.slice(0, 12)).toEqual(
      SHIPPERS.map((shipper) => shipper.name).reverse(),
    );

    // Same created_at: id desc (…5c9 > …5c1 > …5b9 > …5b1), which is neither
    // the insertion order nor its reverse.
    expect(names.slice(12)).toEqual([
      "Tie Two Big",
      "Tie Two Small",
      "Tie One Big",
      "Tie One Small",
    ]);
  });

  it("breaks created_at ties by id desc in both directions", async () => {
    const ascending = await list(`${SHIPPERS_URL}&page=1&sort=created_at&order=asc`);

    expect(ascending.rows.slice(0, 4).map((row) => row.name)).toEqual([
      "Tie Two Big",
      "Tie Two Small",
      "Tie One Big",
      "Tie One Small",
    ]);
  });

  it("sorts by name in both directions, across pages", async () => {
    const asc = [
      ...(await list(`${SHIPPERS_URL}&page=1&sort=name&order=asc`)).rows,
      ...(await list(`${SHIPPERS_URL}&page=2&sort=name&order=asc`)).rows,
    ].map((row) => row.name);

    const expected = [...SHIPPERS, ...TIE_PAIRS]
      .map((shipper) => shipper.name)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    expect(asc).toEqual(expected);

    const desc = (await list(`${SHIPPERS_URL}&page=1&sort=name&order=desc`)).rows;

    expect(desc[0].name).toBe(expected[expected.length - 1]);
  });

  it("filters by status on the server and counts the cards over the company", async () => {
    const inactive = await list(`${SHIPPERS_URL}&page=1&status=inactive`);

    const inactiveSeeded = SHIPPERS.filter((shipper) => !shipper.is_active).length;

    expect(inactive.meta.total).toBe(inactiveSeeded);
    expect(inactive.rows.every((row) => row.is_active === false)).toBe(true);

    // Cards and options: without the Status filter itself, never another
    // company's shipper.
    expect(inactive.meta.searchMeta).toMatchObject({
      total: 16,
      active: 16 - inactiveSeeded,
      withCnpj: SHIPPERS.filter((shipper) => shipper.cnpj).length,
      facets: {
        status: [
          { value: "active", count: 16 - inactiveSeeded },
          { value: "inactive", count: inactiveSeeded },
        ],
      },
    });

    const both = await list(`${SHIPPERS_URL}&page=1&status=active&status=inactive`);

    expect(both.meta.total).toBe(16);
  });

  it("finds a shipper by its CNPJ typed with the mask, with the filter on", async () => {
    const found = await list(
      `${SHIPPERS_URL}&page=1&status=inactive&search=${encodeURIComponent("11.222.333/0001-00")}`,
    );

    expect(found.rows.map((row) => row.name)).toEqual(["Shipper A"]);
    expect(found.meta.searchMeta.total).toBe(1);
  });

  it("refuses a sort or a status the list does not know", async () => {
    expect((await call(`${SHIPPERS_URL}&page=1&sort=cnpj`, tokens.admin)).statusCode).toBe(
      400,
    );
    expect(
      (await call(`${SHIPPERS_URL}&page=1&status=archived`, tokens.admin)).statusCode,
    ).toBe(400);
  });
});

describe("the occurrence types table", () => {
  const URL = "/occurrence-type/list-occurrence-type?page=1&pageSize=10";

  it("filters by impeditiva and foto, each count without its own filter", async () => {
    const result = await list(`${URL}&blocking=yes&photo=no`);

    expect(result.rows.map((row) => row.name).sort()).toEqual([
      "Type Antigo",
      "Type Recusa",
    ]);
    expect(result.meta.total).toBe(2);

    expect(result.meta.searchMeta).toMatchObject({
      // Status breakdown with blocking=yes and photo=no applied.
      total: 2,
      active: 1,
      // Impeditivos: photo=no applied, blocking not.
      blocking: 2,
      // Exigem foto: blocking=yes applied, photo not.
      requiringPhoto: 1,
      facets: {
        blocking: [
          { value: "yes", count: 2 },
          { value: "no", count: 1 },
        ],
        photo: [
          { value: "yes", count: 1 },
          { value: "no", count: 2 },
        ],
      },
    });
  });

  it("sorts by name and keeps another company's types out", async () => {
    const result = await list(`${URL}&sort=name&order=asc`);

    expect(result.rows.map((row) => row.name)).toEqual([
      "Type Antigo",
      "Type Atraso",
      "Type Avaria",
      "Type Portaria",
      "Type Recusa",
    ]);
  });

  it("refuses an unknown yes-or-no value", async () => {
    expect((await call(`${URL}&photo=maybe`, tokens.admin)).statusCode).toBe(400);
  });
});

describe("the status reasons table", () => {
  const URL = "/status-change-reason/list-status-change-reason?page=1&pageSize=10";

  it("filters by status and counts the reasons already in use", async () => {
    const result = await list(`${URL}&status=active&sort=name&order=asc`);

    expect(result.rows.map((row) => row.name)).toEqual(["Reason Livre", "Reason Usado"]);
    expect(result.meta.total).toBe(2);
    expect(result.meta.searchMeta).toMatchObject({
      total: 3,
      active: 2,
      used: 1,
      facets: {
        status: [
          { value: "active", count: 2 },
          { value: "inactive", count: 1 },
        ],
      },
    });
  });
});

describe("the imports table", () => {
  const URL = "/import/list-imports?page=1&pageSize=10&includeReport=false";

  it("filters by origin and status, each count with the other filter", async () => {
    const result = await list(`${URL}&source=NFE_XML`);

    expect(result.meta.total).toBe(2);
    expect(result.rows.every((row) => row.source === "NFE_XML")).toBe(true);

    expect(result.meta.searchMeta.facets).toEqual({
      status: [
        { value: "IN_PROGRESS", count: 0 },
        { value: "COMPLETED", count: 2 },
        { value: "REVERSED", count: 0 },
      ],
      source: [
        { value: "SPREADSHEET", count: 2 },
        { value: "NFE_XML", count: 2 },
      ],
    });
  });

  it("sorts by the imported count", async () => {
    const result = await list(`${URL}&sort=imported&order=desc`);

    expect(result.rows.map((row) => row.imported)).toEqual([40, 12, 5, 3]);
  });
});

describe("who reads the catalog tables", () => {
  const URLS = [
    "/shipper/list-shipper?page=1&pageSize=10",
    "/occurrence-type/list-occurrence-type?page=1&pageSize=10",
    "/status-change-reason/list-status-change-reason?page=1&pageSize=10",
    "/import/list-imports?page=1&pageSize=10",
  ];

  it.each(URLS)("answers a read-only profile: %s", async (url) => {
    expect((await call(url, tokens.readOnly)).statusCode).toBe(200);
  });

  it.each(URLS)("refuses a driver token: %s", async (url) => {
    const response = await call(url, tokens.driver);

    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body).code).toBe("PERMISSION_DENIED");
  });

  it.each(URLS)("refuses another company's manager naming this one: %s", async (url) => {
    const response = await call(`${url}&businessId=${CARRIER}`, tokens.otherAdmin);

    expect(response.statusCode).toBe(403);
  });

  describe("the shipper picker (search-shipper-business)", () => {
    const PICKER = `/shipper/search-shipper-business?businessId=${CARRIER}`;

    it("answers a read-only profile with this company's active shippers", async () => {
      const response = await call(PICKER, tokens.readOnly);

      expect(response.statusCode).toBe(200);

      const [, ...rows] = response.body.split("\n").filter(Boolean);

      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((row) => JSON.parse(row).businessId === CARRIER)).toBe(true);
    });

    it("refuses a driver token with PERMISSION_DENIED", async () => {
      const response = await call(PICKER, tokens.driver);

      expect(response.statusCode).toBe(403);
      expect(JSON.parse(response.body).code).toBe("PERMISSION_DENIED");
    });

    it("refuses another company's manager naming this one", async () => {
      const response = await call(PICKER, tokens.otherAdmin);

      expect(response.statusCode).toBe(403);
      expect(JSON.parse(response.body).code).toBe("TENANT_ACCESS_DENIED");
    });

    it("answers a MASTER naming a company that does not exist with a JSON 404, not a stream", async () => {
      const response = await call(
        `/shipper/search-shipper-business?businessId=${"018fdd00-0000-7000-8000-0000000000ff"}`,
        tokens.master,
      );

      expect(response.statusCode).toBe(404);
      expect(response.headers["content-type"]).toContain("application/json");
      expect(JSON.parse(response.body).code).toBe("TENANT_NOT_FOUND");
    });
  });

  it.each(URLS)("asks the MASTER which company: %s", async (url) => {
    const without = await call(url, tokens.master);

    expect(without.statusCode).toBe(400);
    expect(JSON.parse(without.body).code).toBe("BUSINESS_NOT_IDENTIFIED");

    const scoped = await list(`${url}&businessId=${OTHER}`, tokens.master);

    // The other company's own rows only.
    expect(scoped.rows.every((row) => row.businessId === OTHER)).toBe(true);
  });
});
