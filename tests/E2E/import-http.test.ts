import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { sign } from "jsonwebtoken";

import { randomUUID } from "node:crypto";

import auth from "@/config/auth";

import { readSpreadsheet } from "@/shared/delivery/spreadsheet-reader";
import { importQueue } from "@/modules/import/services/import-queue";
import { parseDeliverySpreadsheet } from "@/shared/delivery/spreadsheet-parser";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * The whole loop, over real HTTP: download the model, fill it in, upload it,
 * read the report, list the uploads, take one back.
 *
 * Every piece of this is proven on its own elsewhere. What only this file can
 * prove is that they are WIRED — that the template the endpoint serves is the
 * one the importer accepts, that the upload creates rows a later request can
 * see, and that the undo removes the rows the upload created rather than
 * whichever rows happen to match a filter.
 *
 * It also proves the listing is a stream. Nothing in a typecheck says so, and
 * a client that calls response.json() on it gets a parse error that reads like
 * a server fault.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018f2000-0000-7000-8000-00000000000a";
const OTHER = "018f2000-0000-7000-8000-00000000000b";

const SHIPPER = "018f2000-0000-7000-8000-0000000000f1";
const DRIVER = "018f2000-0000-7000-8000-0000000000d1";

const CNH = "98765432100";

let token: string;
let otherToken: string;
let driverToken: string;

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
      cnpj: String(11222444000180 + cnpjSeq),
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
  businessId: string,
  role: "BUSINESS_ADMIN" | "BUSINESS_USER",
  driverId?: string,
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
      driverId: driverId ?? null,
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

beforeAll(async () => {
  await seedBusiness(CARRIER);
  await seedBusiness(OTHER);

  await prisma.driver.create({
    data: {
      id: DRIVER,
      name: "Motorista da planilha",
      birth_date: new Date("1990-01-01"),
      cnh: CNH,
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

  await prisma.shipper.create({
    data: { id: SHIPPER, name: "Embarcador", businessId: CARRIER },
  });

  token = await seedUser(CARRIER, "BUSINESS_ADMIN");
  otherToken = await seedUser(OTHER, "BUSINESS_ADMIN");
  driverToken = await seedUser(CARRIER, "BUSINESS_USER", DRIVER);

  ({ app } = await import("@/http"));
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

const HEADER = [
  "Destinatário",
  "CEP",
  "Cidade",
  "UF",
  "Logradouro",
  "Pedido",
  "Rota",
  "CNH do motorista",
];

function csv(rows: string[][]): string {
  const text = [HEADER, ...rows]
    .map((row) => row.map((cell) => `"${cell}"`).join(";"))
    .join("\n");

  return Buffer.from(text, "utf8").toString("base64");
}

function row(recipient: string, code: string, route?: string) {
  return [
    recipient,
    "01001000",
    "São Paulo",
    "SP",
    "Praça da Sé",
    code,
    route ?? "",
    route ? CNH : "",
  ];
}

/**
 * The upload, as the operator lives it: 202 with the open record, then the
 * record once the background processing closed it (import-queue.ts). The
 * rows are processed after the answer, so the report is read where the web
 * reads it — GET /import/get-import. A refusal comes back as it was sent.
 */
async function upload(rows: string[][], as = token) {
  const response = await app.inject({
    method: "POST",
    url: `/import/import-spreadsheet/${CARRIER}`,
    headers: { authorization: `Bearer ${as}` },
    payload: {
      filename: `carga-${randomUUID().slice(0, 8)}.csv`,
      content: csv(rows),
      shipperId: SHIPPER,
    },
  });

  if (response.statusCode !== 202) return response;

  const accepted = response.json();

  expect(accepted.data.status).toBe("IN_PROGRESS");

  await importQueue.idle();

  const detail = await app.inject({
    method: "GET",
    url: `/import/get-import/${accepted.data.id}/business/${CARRIER}`,
    headers: { authorization: `Bearer ${as}` },
  });

  return { statusCode: response.statusCode, json: () => detail.json() };
}

/** The stream, line by line. The first line is the envelope. */
function readNDJSON(body: string) {
  const lines = body
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));

  return { meta: lines[0].meta, rows: lines.slice(1) };
}

describe("the model the endpoint serves", () => {
  it("is a spreadsheet the importer accepts", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/import/download-template",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);

    expect(response.headers["content-type"]).toContain("spreadsheetml");
    expect(response.headers["content-disposition"]).toContain(
      "modelo-importacao",
    );

    // The round trip, over the wire: the bytes the endpoint sent, read back by
    // the parser that has to accept them.
    const matrix = await readSpreadsheet(
      "modelo.xlsx",
      response.rawPayload.toString("base64"),
    );

    const parsed = parseDeliverySpreadsheet(matrix);

    expect(parsed.unknownHeaders).toEqual([]);

    // Blank, because the worked example lives on a second sheet the importer
    // never reads.
    expect(parsed.rows).toEqual([]);
  });

  it("is refused without a token", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/import/download-template",
    });

    expect(response.statusCode).toBe(401);
  });
});

describe("uploading a day's work", () => {
  it("creates the deliveries and closes the record with the per-row report", async () => {
    const response = await upload([
      row("Padaria Central", "PED-001"),
      row("Mercado Novo", "PED-002"),
    ]);

    expect(response.statusCode).toBe(202);

    const body = response.json();

    expect(body.data.imported).toBe(2);
    expect(
      body.data.report.rows.map((entry: { line: number }) => entry.line),
    ).toEqual([2, 3]);

    const created = await prisma.delivery.findMany({
      where: { importId: body.data.id },
    });

    expect(created).toHaveLength(2);
  });

  it("stamps the route it created, so the undo can find it", async () => {
    const response = await upload([
      row("Primeira", "PED-010", "Zona Sul"),
      row("Segunda", "PED-011", "Zona Sul"),
    ]);

    const body = response.json();

    expect(body.data.report.routes).toHaveLength(1);

    const routes = await prisma.route.findMany({
      where: { importId: body.data.id },
    });

    expect(routes).toHaveLength(1);
    expect(routes[0].name).toBe("Zona Sul");
  });

  it("closes the record, rather than leaving it open forever", async () => {
    const response = await upload([row("Padaria Central", "PED-020")]);

    const stored = await prisma.import.findUniqueOrThrow({
      where: { id: response.json().data.id },
    });

    expect(stored.status).toBe("COMPLETED");
    expect(stored.imported).toBe(1);
  });

  it("refuses a driver's token", async () => {
    const response = await upload(
      [row("Padaria Central", "PED-030")],
      driverToken,
    );

    expect(response.statusCode).toBe(403);
  });

  it("refuses another carrier's token on this company's URL", async () => {
    const response = await upload(
      [row("Padaria Central", "PED-031")],
      otherToken,
    );

    expect(response.statusCode).toBe(403);
  });

  it("reports the second sending of the same file as duplicated", async () => {
    // The operator who is not sure whether it went through clicks again.
    await upload([row("Repetida", "PED-040")]);

    const again = await upload([row("Repetida", "PED-040")]);

    expect(again.statusCode).toBe(202);

    const body = again.json();

    expect(body.data.imported).toBe(0);
    expect(body.data.duplicated).toBe(1);
  });
});

/**
 * The upload route allows 6 imports per minute PER USER. The describe blocks
 * below each upload with an admin of their own, so the limiter of one block
 * never turns another block's upload into a 429.
 */
describe("the listing", () => {
  let listingToken: string;

  beforeAll(async () => {
    listingToken = await seedUser(CARRIER, "BUSINESS_ADMIN");
  });

  it("streams NDJSON, newest first", async () => {
    expect(
      (await upload([row("Para a listagem", "PED-050")], listingToken))
        .statusCode,
    ).toBe(202);

    const response = await app.inject({
      method: "GET",
      url: "/import/list-imports?page=1&pageSize=10",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/x-ndjson");

    const { meta, rows } = readNDJSON(response.body);

    expect(meta.total).toBeGreaterThan(0);
    expect(rows.length).toBeGreaterThan(0);

    const timestamps = rows.map((entry) =>
      new Date(entry.created_at).getTime(),
    );

    expect([...timestamps].sort((a, b) => b - a)).toEqual(timestamps);
  });

  it("never shows another carrier's uploads", async () => {
    expect(
      (await upload([row("Só minha", "PED-060")], listingToken)).statusCode,
    ).toBe(202);

    const response = await app.inject({
      method: "GET",
      url: "/import/list-imports?page=1&pageSize=50",
      headers: { authorization: `Bearer ${otherToken}` },
    });

    const { rows } = readNDJSON(response.body);

    expect(rows.every((entry) => entry.businessId === OTHER)).toBe(true);
  });
});

describe("taking an upload back", () => {
  let undoToken: string;

  beforeAll(async () => {
    undoToken = await seedUser(CARRIER, "BUSINESS_ADMIN");
  });

  /** An upload this block can undo; a 429 here would read as an undo bug. */
  async function uploaded(rows: string[][]) {
    const response = await upload(rows, undoToken);

    expect(response.statusCode).toBe(202);

    return response.json();
  }

  it("removes what it created and nothing else", async () => {
    const untouched = await prisma.delivery.create({
      data: {
        recipient_name: "Digitada à mão",
        city: "São Paulo",
        uf: "SP",
        street: "Rua",
        businessId: CARRIER,
        shipperId: SHIPPER,
      },
    });

    const created = await uploaded([row("Da planilha", "PED-070")]);

    const response = await app.inject({
      method: "POST",
      url: `/import/reverse-import/${created.data.id}/business/${CARRIER}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.removedDeliveries).toBe(1);

    expect(
      await prisma.delivery.findMany({ where: { importId: created.data.id } }),
    ).toEqual([]);

    // The hand-typed one is still there. An undo that widened to "everything
    // pending" would have taken it.
    expect(
      await prisma.delivery.findUnique({ where: { id: untouched.id } }),
    ).not.toBeNull();
  });

  it("answers 409 on the second attempt instead of reporting zero", async () => {
    const created = await uploaded([row("Duas vezes", "PED-080")]);

    const url = `/import/reverse-import/${created.data.id}/business/${CARRIER}`;

    await app.inject({
      method: "POST",
      url,
      headers: { authorization: `Bearer ${token}` },
    });

    const again = await app.inject({
      method: "POST",
      url,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(again.statusCode).toBe(409);
  });

  it("answers 404 for another carrier's upload, not 403", async () => {
    // A distinct "exists but is not yours" would tell a caller which ids are
    // real.
    const created = await uploaded([row("Alheia", "PED-090")]);

    const response = await app.inject({
      method: "POST",
      url: `/import/reverse-import/${created.data.id}/business/${OTHER}`,
      headers: { authorization: `Bearer ${otherToken}` },
    });

    expect(response.statusCode).toBe(404);

    expect(
      await prisma.delivery.count({ where: { importId: created.data.id } }),
    ).toBe(1);
  });
});
