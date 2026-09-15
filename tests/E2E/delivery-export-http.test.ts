import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { sign } from "jsonwebtoken";

import { randomUUID } from "node:crypto";

import auth from "@/config/auth";

import { parseCsv } from "@/shared/delivery/spreadsheet-reader";

/**
 * The operation leaving as a file.
 *
 * Three things are only true over real HTTP and are all load-bearing:
 *
 *  - the rows are streamed in cursor batches, so a boundary between two rows
 *    written in the same millisecond must neither repeat a delivery nor skip
 *    one. The seed below crosses a batch boundary on purpose;
 *  - a driver exports their own work and nobody else's, the same rule their
 *    listing obeys — an export that ignored it would be the widest data leak
 *    in the product, since it arrives as a file somebody keeps;
 *  - the answer is a FILE. A client reading it as JSON gets a parse error that
 *    looks like a server fault.
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018f3000-0000-7000-8000-00000000000a";
const OTHER = "018f3000-0000-7000-8000-00000000000b";

const SHIPPER = "018f3000-0000-7000-8000-0000000000f1";
const OTHER_SHIPPER = "018f3000-0000-7000-8000-0000000000f2";

const DRIVER = "018f3000-0000-7000-8000-0000000000d1";
const OTHER_DRIVER = "018f3000-0000-7000-8000-0000000000d2";

let token: string;
let otherToken: string;
let driverToken: string;

const OWN_DELIVERIES = 12;
const DRIVER_DELIVERIES = 5;

/**
 * A third carrier, seeded past two cursor boundaries.
 *
 * The repository pages a thousand at a time, so anything under that exercises
 * a single `findMany` and proves nothing at all about the loop. This is the
 * one assertion that catches the failure that matters: a boundary between two
 * rows written in the same millisecond, repeating a delivery or skipping one
 * in a file the customer keeps and nobody re-checks.
 *
 * It lives on its own carrier so the other assertions stay small and fast.
 */
const BULK_CARRIER = "018f3000-0000-7000-8000-00000000000c";
const BULK_SHIPPER = "018f3000-0000-7000-8000-0000000000f3";

const BULK_DELIVERIES = 2100;

let bulkToken: string;

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
      cnpj: String(11222555000180 + cnpjSeq),
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

async function seedDriver(businessId: string, id: string): Promise<void> {
  await prisma.driver.create({
    data: {
      id,
      name: `Motorista ${id.slice(-2)}`,
      birth_date: new Date("1990-01-01"),
      cnh: `${id}-cnh`,
      cpf: `${id}-cpf`,
      rg: `${id}-rg`,
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
}

beforeAll(async () => {
  await seedBusiness(CARRIER);
  await seedBusiness(OTHER);

  await seedDriver(CARRIER, DRIVER);
  await seedDriver(CARRIER, OTHER_DRIVER);

  await prisma.shipper.create({
    data: { id: SHIPPER, name: "Embarcador", businessId: CARRIER },
  });

  await prisma.shipper.create({
    data: { id: OTHER_SHIPPER, name: "Embarcador alheio", businessId: OTHER },
  });

  await seedBusiness(BULK_CARRIER);

  await prisma.shipper.create({
    data: { id: BULK_SHIPPER, name: "Embarcador grande", businessId: BULK_CARRIER },
  });

  bulkToken = await seedUser(BULK_CARRIER, "BUSINESS_ADMIN");

  // One statement, so a great many of them share a millisecond.
  await prisma.delivery.createMany({
    data: Array.from({ length: BULK_DELIVERIES }, (_, index) => ({
      recipient_name: `Volume ${String(index).padStart(5, "0")}`,
      city: "São Paulo",
      uf: "SP",
      street: "Praça da Sé",
      businessId: BULK_CARRIER,
      shipperId: BULK_SHIPPER,
    })),
  });

  token = await seedUser(CARRIER, "BUSINESS_ADMIN");
  otherToken = await seedUser(OTHER, "BUSINESS_ADMIN");
  driverToken = await seedUser(CARRIER, "BUSINESS_USER", DRIVER);

  // Written in one statement so several land in the same millisecond — the
  // condition a created_at cursor would get wrong.
  await prisma.delivery.createMany({
    data: Array.from({ length: OWN_DELIVERIES }, (_, index) => ({
      recipient_name: `Cliente ${String(index).padStart(3, "0")}`,
      city: "São Paulo",
      uf: "SP",
      street: "Praça da Sé",
      businessId: CARRIER,
      shipperId: SHIPPER,
      driverId: index < DRIVER_DELIVERIES ? DRIVER : OTHER_DRIVER,
    })),
  });

  await prisma.delivery.create({
    data: {
      recipient_name: "De outra transportadora",
      city: "Rio de Janeiro",
      uf: "RJ",
      street: "Avenida Atlântica",
      businessId: OTHER,
      shipperId: OTHER_SHIPPER,
    },
  });

  // One occurrence on a delivery this driver carries, one on a colleague's.
  // The export must hand the driver exactly the first.
  const occurrenceType = await prisma.occurrenceType.create({
    data: {
      name: "Destinatário ausente",
      blocks_delivery: false,
      businessId: CARRIER,
    },
  });

  const mine = await prisma.delivery.findFirstOrThrow({
    where: { businessId: CARRIER, driverId: DRIVER },
  });

  const colleagues = await prisma.delivery.findFirstOrThrow({
    where: { businessId: CARRIER, driverId: OTHER_DRIVER },
  });

  const reporter = await prisma.user.findFirstOrThrow({
    where: { businessId: CARRIER, driverId: DRIVER },
  });

  await prisma.deliveryOccurrence.createMany({
    data: [
      {
        deliveryId: mine.id,
        occurrenceTypeId: occurrenceType.id,
        reportedById: reporter.id,
        description: "Ocorrencia do motorista",
      },
      {
        deliveryId: colleagues.id,
        occurrenceTypeId: occurrenceType.id,
        reportedById: reporter.id,
        description: "Ocorrencia do colega",
      },
    ],
  });

  ({ app } = await import("@/http"));
  await app.ready();
}, 90_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

async function exportDeliveries(query = "", as = token) {
  return app.inject({
    method: "GET",
    url: `/delivery/export-delivery${query}`,
    headers: { authorization: `Bearer ${as}` },
  });
}

/** The file as a person would open it: a header row, then one row per record. */
function rowsOf(body: string): string[][] {
  const matrix = parseCsv(body);

  return matrix
    .slice(1)
    .map((row) => row.map((cell) => String(cell ?? "")))
    .filter((row) => row.some((cell) => cell !== ""));
}

describe("exporting the operation", () => {
  it("answers with a file, not with JSON", async () => {
    const response = await exportDeliveries();

    expect(response.statusCode).toBe(200);

    expect(response.headers["content-type"]).toContain("csv");
    expect(response.headers["content-disposition"]).toContain("entregas-");

    // The assertion that matters to a client: this is not parseable as JSON.
    expect(() => JSON.parse(response.body)).toThrow();
  });

  it("returns every row and each one once", async () => {
    const response = await exportDeliveries();

    const rows = rowsOf(response.body);

    expect(rows).toHaveLength(OWN_DELIVERIES);

    const ids = rows.map((row) => row[0]);

    expect(new Set(ids).size).toBe(OWN_DELIVERIES);
  });

  it("loses no row across two cursor boundaries", async () => {
    // Past 2 × 1000, with most of the rows written in the same millisecond.
    // A cursor on created_at instead of id either repeats a delivery here or
    // skips one, and both produce a file that looks perfectly plausible.
    const response = await exportDeliveries("", bulkToken);

    const rows = rowsOf(response.body);

    expect(rows).toHaveLength(BULK_DELIVERIES);
    expect(new Set(rows.map((row) => row[0])).size).toBe(BULK_DELIVERIES);
  }, 60_000);

  it("writes the status in Portuguese, because a person reads it", async () => {
    const response = await exportDeliveries();

    const [first] = rowsOf(response.body);

    expect(first[4]).toBe("Pendente");
  });

  it("never reaches another carrier's rows", async () => {
    const response = await exportDeliveries("", otherToken);

    const rows = rowsOf(response.body);

    expect(rows).toHaveLength(1);
    expect(rows[0].join(" ")).toContain("De outra transportadora");
  });

  it("gives a driver their own work and nobody else's", async () => {
    const response = await exportDeliveries("", driverToken);

    expect(rowsOf(response.body)).toHaveLength(DRIVER_DELIVERIES);
  });

  it("narrows to a status when one is asked for", async () => {
    const response = await exportDeliveries("?status=DELIVERED");

    expect(rowsOf(response.body)).toHaveLength(0);
  });

  it("narrows to a search term", async () => {
    const response = await exportDeliveries("?search=Cliente%20001");

    expect(rowsOf(response.body)).toHaveLength(1);
  });

  it("answers excel when asked for excel", async () => {
    const response = await exportDeliveries("?format=excel");

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("spreadsheetml");
  });

  it("is refused without a token", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/delivery/export-delivery",
    });

    expect(response.statusCode).toBe(401);
  });
});

async function exportOccurrences(as = token) {
  return app.inject({
    method: "GET",
    url: "/delivery/export-occurrence",
    headers: { authorization: `Bearer ${as}` },
  });
}

describe("exporting the occurrences", () => {
  it("answers with a file the dispatcher can open", async () => {
    const response = await exportOccurrences();

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("csv");

    expect(rowsOf(response.body)).toHaveLength(2);
  });

  it("gives a driver only the occurrences on their own deliveries", async () => {
    // The permission middleware lets a driver through on occurrence_manage
    // write, so the scoping here is the ONLY thing between them and every
    // occurrence in the company — as a file they keep.
    const response = await exportOccurrences(driverToken);

    const rows = rowsOf(response.body);

    expect(rows).toHaveLength(1);
    expect(rows.join(" ")).toContain("Ocorrencia do motorista");
    expect(rows.join(" ")).not.toContain("Ocorrencia do colega");
  });

  it("never reaches another carrier's occurrences", async () => {
    const response = await exportOccurrences(otherToken);

    expect(rowsOf(response.body)).toHaveLength(0);
  });

  it("writes whether the type blocks the delivery in words", async () => {
    // The column is read, filtered and counted by a person in a spreadsheet.
    const response = await exportOccurrences();

    expect(rowsOf(response.body)[0]).toContain("Não");
  });

  it("is refused without a token", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/delivery/export-occurrence",
    });

    expect(response.statusCode).toBe(401);
  });
});
