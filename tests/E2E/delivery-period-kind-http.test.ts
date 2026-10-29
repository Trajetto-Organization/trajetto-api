import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { sign } from "jsonwebtoken";

import { randomUUID } from "node:crypto";

import auth from "@/config/auth";

import { parseCsv } from "@/shared/delivery/spreadsheet-reader";
import { businessDayWindow } from "@/shared/time/business-day";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * The Entregas list's period and the record's type (meeting of 14/10/2026),
 * over real HTTP and Postgres: the querystring the route validates, the SQL
 * `where` and the single-scan counts the repository runs, and the columns
 * the create and the export really write.
 *
 * - `period=today` lists the company's day (its zone, not the server's) and
 *   the cards and the pager count only it; no period = every date.
 * - an exact `search` (id, order code, NF-e key) sets the period aside, so
 *   a notification's `?search=<id>` link still finds last month's delivery.
 * - `kind` is written by the create, returned by the list and the detail,
 *   filtered by the list and the export, and printed in the export's Tipo.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018fdc10-0000-7000-8000-00000000000a";
const OTHER = "018fdc10-0000-7000-8000-00000000000b";
const SHIPPER = "018fdc10-0000-7000-8000-0000000000f1";
const OTHER_SHIPPER = "018fdc10-0000-7000-8000-0000000000f2";
const OLD_DELIVERY = "018fdc10-0000-7000-8000-0000000000c1";
const FOREIGN_DELIVERY = "018fdc10-0000-7000-8000-0000000000c2";

const ZONE = "America/Sao_Paulo";

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
      timezone: ZONE,
    },
  });

  await prisma.businessEntitlement.create({
    data: { businessId: id, module: "DELIVERIES", enabled: true },
  });
}

async function seedAdmin(businessId: string): Promise<string> {
  const id = randomUUID();
  const familyId = randomUUID();

  await prisma.user.create({
    data: {
      id,
      name: "Gestora",
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

  return sign(
    { tokenType: "access", sessionVersion: 0, familyId },
    auth.secret_token,
    { subject: id, expiresIn: "15m" },
  );
}

beforeAll(async () => {
  await seedBusiness(CARRIER);
  await seedBusiness(OTHER);

  await prisma.shipper.createMany({
    data: [
      { id: SHIPPER, name: "Atacado Sul", businessId: CARRIER },
      { id: OTHER_SHIPPER, name: "Embarcador alheio", businessId: OTHER },
    ],
  });

  tokens.admin = await seedAdmin(CARRIER);

  // Today (the company's day, whatever the server's clock says) and the
  // first day of the last 40 days: in the company and outside any preset.
  const today = businessDayWindow(new Date(), ZONE, 1);
  const longAgo = businessDayWindow(new Date(), ZONE, 40);

  const base = {
    city: "São Paulo",
    uf: "SP",
    street: "Rua",
    businessId: CARRIER,
    shipperId: SHIPPER,
  };

  await prisma.delivery.createMany({
    data: [
      {
        ...base,
        recipient_name: "Padaria de hoje",
        created_at: new Date(today.start.getTime() + 60_000),
      },
      {
        ...base,
        recipient_name: "Cestos retornáveis de hoje",
        kind: "SERVICE_ORDER",
        status: "DELIVERED",
        created_at: new Date(today.start.getTime() + 120_000),
      },
      {
        ...base,
        id: OLD_DELIVERY,
        recipient_name: "Mercado antigo",
        code: "PED-9001",
        created_at: new Date(longAgo.start.getTime() + 60_000),
      },
      {
        // Another company, created today: never counted, never found.
        id: FOREIGN_DELIVERY,
        city: "Rio de Janeiro",
        uf: "RJ",
        street: "Avenida",
        businessId: OTHER,
        shipperId: OTHER_SHIPPER,
        recipient_name: "Cliente de outra transportadora",
        code: "PED-9001",
        created_at: new Date(today.start.getTime() + 60_000),
      },
    ],
  });

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

function call(
  method: "GET" | "POST",
  url: string,
  payload?: unknown,
  token = tokens.admin,
) {
  return app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${token}`,
      ...(payload !== undefined && { "content-type": "application/json" }),
    },
    ...(payload !== undefined && { payload: JSON.stringify(payload) }),
  });
}

function ndjson(body: string): { meta: Record<string, any>; rows: any[] } {
  const [head, ...lines] = body.split("\n").filter(Boolean);

  return {
    meta: JSON.parse(head).meta,
    rows: lines.map((line) => JSON.parse(line)),
  };
}

const list = async (query: string) => {
  const response = await call(
    "GET",
    `/delivery/list-delivery?page=1&pageSize=10${query}`,
  );

  expect(response.statusCode, response.body).toBe(200);

  return ndjson(response.body);
};

describe("the list's period", () => {
  it("lists the company's day with period=today, and counts only it", async () => {
    const { meta, rows } = await list("&period=today");

    expect(rows.map((row) => row.recipient_name).sort()).toEqual([
      "Cestos retornáveis de hoje",
      "Padaria de hoje",
    ]);
    expect(meta.total).toBe(2);
    expect(meta.searchMeta.statusCounts).toEqual({ PENDING: 1, DELIVERED: 1 });
    expect(meta.searchMeta.period).toEqual({
      from: businessDayWindow(new Date(), ZONE, 1).keys[0],
      to: businessDayWindow(new Date(), ZONE, 1).keys[0],
      applied: true,
    });
  });

  it("lists every date without a period, as the callers before it expect", async () => {
    const { meta } = await list("");

    expect(meta.total).toBe(3);
    expect(meta.searchMeta.period).toBeNull();
  });

  it("finds last month's delivery by its exact id or order code, with the period set aside", async () => {
    for (const search of [OLD_DELIVERY, "ped-9001"]) {
      const { meta, rows } = await list(`&period=today&search=${search}`);

      expect(rows.map((row) => row.id)).toEqual([OLD_DELIVERY]);
      expect(meta.total).toBe(1);
      expect(meta.searchMeta.period.applied).toBe(false);
    }
  });

  it("keeps a partial term inside the period, and never finds another company's id", async () => {
    const partial = await list("&period=today&search=Mercado");
    const foreign = await list(`&period=today&search=${FOREIGN_DELIVERY}`);

    expect(partial.rows).toEqual([]);
    expect(partial.meta.searchMeta.period.applied).toBe(true);
    expect(foreign.rows).toEqual([]);
  });

  it("refuses a custom range longer than 92 days, in Portuguese", async () => {
    const response = await call(
      "GET",
      "/delivery/list-delivery?page=1&pageSize=10&period=custom&from=2026-01-01&to=2026-06-30",
    );

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain(
      "O período personalizado pode ter no máximo 92 dias.",
    );
  });
});

describe("the record's type", () => {
  it("is written by the create, read back by the detail and filtered by the list", async () => {
    const created = await call("POST", `/delivery/create-delivery/${CARRIER}`, {
      shipperId: SHIPPER,
      kind: "SERVICE_ORDER",
      recipient_name: "Recolher cestos",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua das Flores",
    });

    expect(created.statusCode, created.body).toBe(201);

    const id = created.json().data.id;
    const detail = await call(
      "GET",
      `/delivery/get-delivery/${id}/business/${CARRIER}`,
    );

    expect(detail.statusCode).toBe(200);
    expect(detail.json().data.kind).toBe("SERVICE_ORDER");

    const { rows } = await list("&period=today&kind=SERVICE_ORDER");

    expect(rows.map((row) => row.recipient_name).sort()).toEqual([
      "Cestos retornáveis de hoje",
      "Recolher cestos",
    ]);
    expect(rows.every((row) => row.kind === "SERVICE_ORDER")).toBe(true);
  });

  it("refuses PICKUP on the panel's create", async () => {
    const response = await call(
      "POST",
      `/delivery/create-delivery/${CARRIER}`,
      {
        shipperId: SHIPPER,
        kind: "PICKUP",
        recipient_name: "Coleta",
        cep: "01001000",
        city: "São Paulo",
        uf: "SP",
        street: "Rua das Flores",
      },
    );

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain("Tipo inválido");
  });

  it("is a column of the export, which takes the period and the type filter", async () => {
    const response = await call(
      "GET",
      "/delivery/export-delivery?format=csv&period=today&kind=SERVICE_ORDER",
    );

    expect(response.statusCode).toBe(200);

    const [header, ...rows] = parseCsv(response.body).filter((row) =>
      row.some((cell) => String(cell ?? "") !== ""),
    );
    const tipo = header.indexOf("Tipo");

    expect(tipo).toBeGreaterThan(-1);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row[tipo] === "Ordem de serviço")).toBe(true);
  });
});
