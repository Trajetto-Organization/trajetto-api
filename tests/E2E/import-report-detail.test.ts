import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { sign } from "jsonwebtoken";

import { randomUUID } from "node:crypto";

import auth from "@/config/auth";

/**
 * The upload history without every upload's report in it.
 *
 * Each import keeps its per-row report — one entry per spreadsheet line, tens
 * of thousands for a big day — and the listing returned it for every import on
 * the page. A carrier opening its history with pageSize=100 pulled a hundred of
 * those out of TOAST and held them in the replica's memory at once, to draw a
 * table that shows four numbers per upload.
 *
 * The listing now leaves the report out unless the caller asks for it
 * (includeReport=true), and the report of ONE upload comes from its own
 * endpoint, when the operator opens it. The default flipped because the tab's
 * generic list fetch never sent the flag: every page still carried megabytes
 * of reports, deep-copied and gzipped on the event loop.
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018fdd00-0000-7000-8000-00000000000a";
const OTHER = "018fdd00-0000-7000-8000-00000000000b";

const REPORT_ROWS = 20_000;

let token: string;
let otherToken: string;

let bigImportId: string;
let performer: string;

async function seedBusiness(id: string): Promise<void> {
  await prisma.business.create({
    data: {
      id,
      corporate_reason: `Transportadora ${id}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(54000000000000 + Math.floor(Math.random() * 9000000)),
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
): Promise<{ id: string; token: string }> {
  const id = randomUUID();
  const familyId = randomUUID();

  await prisma.user.create({
    data: {
      id,
      name: "Usuário",
      email: `${id}@exemplo.com.br`,
      password: "not-used-here",
      role: "BUSINESS_ADMIN",
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

  return {
    id,
    token: sign(
      { tokenType: "access", sessionVersion: 0, familyId },
      auth.secret_token,
      { subject: id, expiresIn: "15m" },
    ),
  };
}

function reportOf(rows: number) {
  return {
    imported: rows,
    duplicated: 0,
    invalid: 0,
    unknownHeaders: ["coluna_estranha"],
    rows: Array.from({ length: rows }, (_, index) => ({
      line: index + 2,
      outcome: "imported",
      recipient_name: `Destinatário com um nome razoavelmente comprido ${index}`,
      reference: `PED-${String(index).padStart(6, "0")}`,
      message: null,
    })),
    routes: [],
  };
}

function readNDJSON(body: string) {
  const lines = body
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));

  return { meta: lines[0].meta, rows: lines.slice(1) };
}

beforeAll(async () => {
  await seedBusiness(CARRIER);
  await seedBusiness(OTHER);

  const carrierUser = await seedUser(CARRIER);
  performer = carrierUser.id;
  token = carrierUser.token;

  otherToken = (await seedUser(OTHER)).token;

  // Ten uploads, one of them a big day. Written straight to the table: the
  // importer is not what is under test, and twenty thousand rows through it
  // would be minutes.
  for (let index = 0; index < 9; index += 1) {
    await prisma.import.create({
      data: {
        source: "SPREADSHEET",
        status: "COMPLETED",
        filename: `pequena-${index}.xlsx`,
        imported: 3,
        report: reportOf(3),
        businessId: CARRIER,
        performedById: performer,
      },
    });
  }

  const big = await prisma.import.create({
    data: {
      source: "SPREADSHEET",
      status: "COMPLETED",
      filename: "dia-grande.xlsx",
      imported: REPORT_ROWS,
      report: reportOf(REPORT_ROWS),
      businessId: CARRIER,
      performedById: performer,
    },
  });

  bigImportId = big.id;

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await prisma.import.deleteMany({
    where: { businessId: { in: [CARRIER, OTHER] } },
  });
  await app.close();
  await prisma.$disconnect();
});

describe("the listing, asked without reports", () => {
  it("carries the counters and not the per-row report", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/import/list-imports?page=1&pageSize=10&includeReport=false",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);

    const { meta, rows } = readNDJSON(response.body);

    expect(meta.total).toBe(10);
    expect(rows).toHaveLength(10);

    for (const entry of rows) {
      expect(entry).not.toHaveProperty("report");
      expect(entry).toMatchObject({
        id: expect.any(String),
        filename: expect.any(String),
        status: "COMPLETED",
        imported: expect.any(Number),
      });
    }

    // A page of ten uploads is a few kilobytes, whatever their size was.
    expect(response.body.length).toBeLessThan(20_000);
  });
});

describe("the listing, asked without the flag", () => {
  it("leaves the report out by default", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/import/list-imports?page=1&pageSize=10",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);

    const { rows } = readNDJSON(response.body);

    expect(rows).toHaveLength(10);
    expect(rows.every((entry) => !("report" in entry))).toBe(true);
    expect(response.body.length).toBeLessThan(20_000);
  });
});

describe("the listing, asked with includeReport=true", () => {
  it("still carries the report for a caller that needs it", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/import/list-imports?page=1&pageSize=10&includeReport=true",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);

    const { rows } = readNDJSON(response.body);
    const big = rows.find((entry) => entry.id === bigImportId);

    expect(big.report.rows).toHaveLength(REPORT_ROWS);
  });
});

describe("the report of one upload", () => {
  it("comes whole from its own endpoint", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/import/get-import/${bigImportId}/business/${CARRIER}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode, response.body.slice(0, 300)).toBe(200);

    const { data } = response.json();

    expect(data.id).toBe(bigImportId);
    expect(data.filename).toBe("dia-grande.xlsx");
    expect(data.report.rows).toHaveLength(REPORT_ROWS);
    expect(data.report.unknownHeaders).toEqual(["coluna_estranha"]);
  });

  it("answers an upload still being written, instead of failing on its status", async () => {
    const running = await prisma.import.create({
      data: {
        source: "SPREADSHEET",
        status: "IN_PROGRESS",
        filename: "em-andamento.xlsx",
        report: reportOf(0),
        businessId: CARRIER,
        performedById: performer,
      },
    });

    const response = await app.inject({
      method: "GET",
      url: `/import/get-import/${running.id}/business/${CARRIER}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode, response.body.slice(0, 300)).toBe(200);
    expect(response.json().data.status).toBe("IN_PROGRESS");
  });

  it("is not another carrier's to read", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/import/get-import/${bigImportId}/business/${CARRIER}`,
      headers: { authorization: `Bearer ${otherToken}` },
    });

    expect([403, 404]).toContain(response.statusCode);
    expect(response.body).not.toContain("dia-grande.xlsx");
  });

  it("is not found through another carrier's id either", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/import/get-import/${bigImportId}/business/${OTHER}`,
      headers: { authorization: `Bearer ${otherToken}` },
    });

    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain("dia-grande.xlsx");
  });

  it("answers 404 for an id that does not exist", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/import/get-import/${randomUUID()}/business/${CARRIER}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().message).toEqual(expect.any(String));
  });
});
