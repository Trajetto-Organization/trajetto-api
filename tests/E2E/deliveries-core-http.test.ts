import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { sign } from "jsonwebtoken";

import { randomUUID } from "node:crypto";

import auth from "@/config/auth";

import { parseCsv } from "@/shared/delivery/spreadsheet-reader";
import { violatesUniqueOn } from "@/shared/delivery/unique-violation";

import { OccurrenceTypeRepository } from "@/modules/occurrence-type/repositories/occurrence-type-repository";

/**
 * Entregas, over real HTTP and Postgres (package dlv-core).
 *
 * Everything here is a behaviour a fake cannot vouch for: what the Prisma
 * `where` of the list and the export actually match, what the unique indexes
 * name in a P2002, which role a route lets through, and what one transaction
 * writes (an XML upload's Importações row, the webhook rows of a reversal).
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018fdc00-0000-7000-8000-00000000000a";
const OTHER = "018fdc00-0000-7000-8000-00000000000b";
const SUSPENDED = "018fdc00-0000-7000-8000-00000000000c";

const SHIPPER = "018fdc00-0000-7000-8000-0000000000f1";
const SECOND_SHIPPER = "018fdc00-0000-7000-8000-0000000000f2";
const RETIRED_SHIPPER = "018fdc00-0000-7000-8000-0000000000f3";
const OTHER_SHIPPER = "018fdc00-0000-7000-8000-0000000000f4";
const SUSPENDED_SHIPPER = "018fdc00-0000-7000-8000-0000000000f5";

const DRIVER = "018fdc00-0000-7000-8000-0000000000d1";
const REASON = "018fdc00-0000-7000-8000-0000000000e1";
const SUSPENDED_TYPE = "018fdc00-0000-7000-8000-0000000000c5";

const tokens: Record<string, string> = {};

let cnpjSeq = 0;

async function seedBusiness(id: string, is_active = true): Promise<void> {
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
      cnpj: String(33444555000100 + cnpjSeq),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `${id}@exemplo.com.br`,
      is_active,
    },
  });

  await prisma.businessEntitlement.create({
    data: { businessId: id, module: "DELIVERIES", enabled: true },
  });
}

async function seedUser(
  businessId: string | null,
  role: "MASTER" | "BUSINESS_ADMIN" | "BUSINESS_USER",
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

function nfe(accessKey: string, issuerCnpj: string, issuerName: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">
  <NFe>
    <infNFe Id="NFe${accessKey}" versao="4.00">
      <ide><nNF>${accessKey.slice(-6)}</nNF></ide>
      <emit><CNPJ>${issuerCnpj}</CNPJ><xNome>${issuerName}</xNome></emit>
      <dest>
        <CNPJ>98765432000188</CNPJ>
        <xNome>Mercado ${accessKey.slice(-4)}</xNome>
        <enderDest>
          <xLgr>Rua das Palmeiras</xLgr><nro>450</nro><xBairro>Centro</xBairro>
          <xMun>Campinas</xMun><UF>SP</UF><CEP>13010000</CEP>
        </enderDest>
      </dest>
      <det nItem="1">
        <prod><xProd>Caixa de leite</xProd><qCom>12.0000</qCom><uCom>CX</uCom><vUnCom>4.5000</vUnCom></prod>
      </det>
    </infNFe>
  </NFe>
</nfeProc>`;
}

const KEY = (n: number) => `352406112223330001815500100000${String(n).padStart(4, "0")}1000012345`;

beforeAll(async () => {
  await seedBusiness(CARRIER);
  await seedBusiness(OTHER);
  await seedBusiness(SUSPENDED, false);

  await prisma.driver.create({
    data: {
      id: DRIVER,
      name: "João Rodovia",
      birth_date: new Date("1990-01-01"),
      cnh: "55544433322",
      cpf: "55544433322-cpf",
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

  await prisma.shipper.createMany({
    data: [
      { id: SHIPPER, name: "Atacado Sul", businessId: CARRIER },
      { id: SECOND_SHIPPER, name: "Bebidas Norte", businessId: CARRIER },
      {
        id: RETIRED_SHIPPER,
        name: "Embarcador desativado",
        businessId: CARRIER,
        is_active: false,
      },
      { id: OTHER_SHIPPER, name: "Embarcador alheio", businessId: OTHER },
      { id: SUSPENDED_SHIPPER, name: "Embarcador suspenso", businessId: SUSPENDED },
    ],
  });

  await prisma.occurrenceType.create({
    data: { id: SUSPENDED_TYPE, name: "Avaria", businessId: SUSPENDED },
  });

  await prisma.statusChangeReason.create({
    data: { id: REASON, name: "Cliente confirmou", businessId: CARRIER },
  });

  tokens.admin = await seedUser(CARRIER, "BUSINESS_ADMIN");
  tokens.otherAdmin = await seedUser(OTHER, "BUSINESS_ADMIN");
  tokens.master = await seedUser(null, "MASTER");
  tokens.driver = await seedUser(CARRIER, "BUSINESS_USER", DRIVER);

  // The listing and the export: three with the driver, two without.
  const rows: Array<[string, string, string | null]> = [
    ["Padaria Estrela", SHIPPER, DRIVER],
    ["Mercado Central", SHIPPER, DRIVER],
    ["Farmácia Boa Saúde", SECOND_SHIPPER, DRIVER],
    ["Loja do Bairro", SECOND_SHIPPER, null],
    ["Açougue Bom Corte", SHIPPER, null],
  ];

  for (const [recipient_name, shipperId, driverId] of rows) {
    await prisma.delivery.create({
      data: {
        recipient_name,
        city: "São Paulo",
        uf: "SP",
        street: "Rua",
        businessId: CARRIER,
        shipperId,
        driverId,
      },
    });
  }

  await prisma.delivery.create({
    data: {
      recipient_name: "Cliente de outra transportadora",
      city: "Rio de Janeiro",
      uf: "RJ",
      street: "Avenida",
      businessId: OTHER,
      shipperId: OTHER_SHIPPER,
    },
  });

  // Every document topic reaches this ERP.
  await prisma.webhookEndpoint.create({
    data: {
      name: "ERP",
      url: "https://erp.exemplo.com.br/webhooks",
      secret: "whsec_teste",
      topics: ["delivery.*"],
      businessId: CARRIER,
    },
  });

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

function call(
  method: "GET" | "POST" | "PATCH" | "DELETE" | "PUT",
  url: string,
  token: string,
  payload?: unknown,
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

function csvRows(body: string): string[][] {
  return parseCsv(body)
    .slice(1)
    .map((row) => row.map((cell) => String(cell ?? "")))
    .filter((row) => row.some((cell) => cell !== ""));
}

describe("the deliveries listing on the server (decision 8.8)", () => {
  it("filters by several statuses and shippers, and counts the cards over the company", async () => {
    const response = await call(
      "GET",
      `/delivery/list-delivery?page=1&pageSize=10&shipperId=${SECOND_SHIPPER}`,
      tokens.admin,
    );

    expect(response.statusCode).toBe(200);

    const { meta, rows } = ndjson(response.body);

    expect(rows.map((row) => row.recipient_name).sort()).toEqual([
      "Farmácia Boa Saúde",
      "Loja do Bairro",
    ]);
    expect(meta.total).toBe(2);
    expect(meta.searchMeta.statusCounts).toEqual({ PENDING: 2 });

    // The shipper facet is counted without itself: both shippers offered.
    expect(
      meta.searchMeta.facets.shipperId.map((option: { label: string }) => option.label),
    ).toEqual(["Atacado Sul", "Bebidas Norte"]);
  });

  it("finds a delivery by the driver's name and by its copied id", async () => {
    const byDriver = ndjson(
      (
        await call(
          "GET",
          "/delivery/list-delivery?page=1&pageSize=10&search=Rodovia",
          tokens.admin,
        )
      ).body,
    );

    expect(byDriver.meta.total).toBe(3);

    const id = byDriver.rows[0].id;

    const byId = ndjson(
      (
        await call("GET", `/delivery/list-delivery?page=1&pageSize=10&search=${id}`, tokens.admin)
      ).body,
    );

    expect(byId.rows.map((row) => row.id)).toEqual([id]);
  });

  it("sorts on the server and refuses a column it cannot sort", async () => {
    const sorted = ndjson(
      (
        await call(
          "GET",
          "/delivery/list-delivery?page=1&pageSize=10&sort=recipient_name&order=asc",
          tokens.admin,
        )
      ).body,
    );

    const names = sorted.rows.map((row) => row.recipient_name);

    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, "pt-BR")));

    const refused = await call(
      "GET",
      "/delivery/list-delivery?page=1&pageSize=10&sort=driverId",
      tokens.admin,
    );

    expect(refused.statusCode).toBe(400);
  });

  it("keeps a manager of another company out, and scopes a driver to their own", async () => {
    const foreign = await call(
      "GET",
      `/delivery/list-delivery?page=1&pageSize=10&businessId=${CARRIER}`,
      tokens.otherAdmin,
    );

    expect(foreign.statusCode).toBe(403);

    const mine = ndjson(
      (await call("GET", "/delivery/list-delivery?page=1&pageSize=10", tokens.driver)).body,
    );

    expect(mine.meta.total).toBe(3);
  });
});

describe("exporting what the screen shows (decisions 5.8, DLV-EXP-1/2)", () => {
  it("exports as MASTER for the company chosen on screen", async () => {
    const response = await call(
      "GET",
      `/delivery/export-delivery?businessId=${CARRIER}`,
      tokens.master,
    );

    expect(response.statusCode).toBe(200);
    expect(csvRows(response.body)).toHaveLength(5);
  });

  it("tells a MASTER who names no company to pick one", async () => {
    const response = await call("GET", "/delivery/export-delivery", tokens.master);

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).code).toBe("BUSINESS_NOT_IDENTIFIED");
  });

  it("applies the listing's search (driver name) and facets", async () => {
    const byDriver = await call(
      "GET",
      "/delivery/export-delivery?search=Rodovia",
      tokens.admin,
    );

    expect(csvRows(byDriver.body)).toHaveLength(3);

    const byFacets = await call(
      "GET",
      `/delivery/export-delivery?shipperId=${SHIPPER}&status=PENDING,IN_TRANSIT`,
      tokens.admin,
    );

    expect(csvRows(byFacets.body)).toHaveLength(3);
  });

  it("exports the occurrences as MASTER too, with the feed's search by copied id", async () => {
    const delivery = await prisma.delivery.findFirstOrThrow({
      where: { businessId: CARRIER, recipient_name: "Padaria Estrela" },
    });

    const type = await prisma.occurrenceType.create({
      data: { name: "Cliente ausente", businessId: CARRIER },
    });

    const reporter = await prisma.user.findFirstOrThrow({
      where: { businessId: CARRIER, role: "BUSINESS_ADMIN" },
    });

    const occurrence = await prisma.deliveryOccurrence.create({
      data: {
        deliveryId: delivery.id,
        businessId: CARRIER,
        occurrenceTypeId: type.id,
        reportedById: reporter.id,
        description: "Ninguém atendeu",
      },
    });

    const asMaster = await call(
      "GET",
      `/delivery/export-occurrence?businessId=${CARRIER}`,
      tokens.master,
    );

    expect(asMaster.statusCode).toBe(200);
    expect(csvRows(asMaster.body)).toHaveLength(1);

    for (const pasted of [occurrence.id, delivery.id]) {
      const response = await call(
        "GET",
        `/delivery/export-occurrence?search=${pasted}`,
        tokens.admin,
      );

      expect(csvRows(response.body).map((row) => row[0])).toEqual([occurrence.id]);
    }

    const informational = await call(
      "GET",
      "/delivery/export-occurrence?severity=blocking",
      tokens.admin,
    );

    expect(csvRows(informational.body)).toHaveLength(0);
  });
});

describe("a deactivated shipper takes no new deliveries (decision 5.7)", () => {
  it("refuses moving a delivery onto it by edit", async () => {
    const delivery = await prisma.delivery.findFirstOrThrow({
      where: { businessId: CARRIER, recipient_name: "Loja do Bairro" },
    });

    const response = await call(
      "PATCH",
      `/delivery/update-delivery/${delivery.id}/business/${CARRIER}`,
      tokens.admin,
      { shipperId: RETIRED_SHIPPER },
    );

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).code).toBe("SHIPPER_INACTIVE");
  });

  it("refuses it as the forced shipper of an XML upload", async () => {
    const response = await call("POST", `/delivery/import-xml/${CARRIER}`, tokens.admin, {
      shipperId: RETIRED_SHIPPER,
      files: [{ filename: "nota.xml", content: nfe(KEY(1), "11222333000181", "Indústria X") }],
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).code).toBe("SHIPPER_INACTIVE");
  });
});

describe("the NF-e key is set once (decision 5.2)", () => {
  it("accepts a key on a typed delivery, then refuses to change it", async () => {
    const delivery = await prisma.delivery.findFirstOrThrow({
      where: { businessId: CARRIER, recipient_name: "Açougue Bom Corte" },
    });

    const set = await call(
      "PATCH",
      `/delivery/update-delivery/${delivery.id}/business/${CARRIER}`,
      tokens.admin,
      {
        invoice_key: KEY(50),
        items: [{ description: "Peça de picanha", quantity: 3 }],
      },
    );

    expect(set.statusCode).toBe(200);

    const stored = await prisma.delivery.findUniqueOrThrow({
      where: { id: delivery.id },
      include: { items: true },
    });

    expect(stored.invoice_key).toBe(KEY(50));
    expect(stored.items.map((item) => item.description)).toEqual(["Peça de picanha"]);

    const changed = await call(
      "PATCH",
      `/delivery/update-delivery/${delivery.id}/business/${CARRIER}`,
      tokens.admin,
      { invoice_key: KEY(51) },
    );

    expect(changed.statusCode).toBe(400);
    expect(JSON.parse(changed.body).code).toBe("DELIVERY_INVOICE_KEY_IMMUTABLE");
  });

  it("answers 409 for a key another delivery holds", async () => {
    const [a, b] = await prisma.delivery.findMany({
      where: { businessId: CARRIER, invoice_key: null, status: "PENDING" },
      take: 2,
    });

    await prisma.delivery.update({ where: { id: a.id }, data: { invoice_key: KEY(60) } });

    const response = await call(
      "PATCH",
      `/delivery/update-delivery/${b.id}/business/${CARRIER}`,
      tokens.admin,
      { invoice_key: KEY(60) },
    );

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).code).toBe("DELIVERY_INVOICE_KEY_EXISTS");
  });

  it("names the invoice_key index in the P2002 the race branch reads", async () => {
    const error = await prisma.delivery
      .create({
        data: {
          recipient_name: "Duplicada",
          city: "São Paulo",
          uf: "SP",
          street: "Rua",
          businessId: CARRIER,
          shipperId: SHIPPER,
          invoice_key: KEY(60),
        },
      })
      .catch((caught: unknown) => caught);

    expect(violatesUniqueOn(error, "invoice_key")).toBe(true);
    expect(violatesUniqueOn(error, "client_submission_id")).toBe(false);
  });
});

describe("the expected date is a day (decision 1.3)", () => {
  it("stores the day sent and refuses an instant", async () => {
    const created = await call("POST", `/delivery/create-delivery/${CARRIER}`, tokens.admin, {
      shipperId: SHIPPER,
      recipient_name: "Cliente com data",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Praça da Sé",
      scheduled_date: "2026-09-17",
      notes: "Portão azul.\n\nTocar o 2.",
    });

    expect(created.statusCode).toBe(201);

    const stored = await prisma.delivery.findUniqueOrThrow({
      where: { id: JSON.parse(created.body).data.id },
    });

    expect(stored.scheduled_date?.toISOString()).toBe("2026-09-17T00:00:00.000Z");

    const refused = await call("POST", `/delivery/create-delivery/${CARRIER}`, tokens.admin, {
      shipperId: SHIPPER,
      recipient_name: "Cliente com instante",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Praça da Sé",
      scheduled_date: "2026-09-17T03:00:00.000Z",
    });

    expect(refused.statusCode).toBe(400);
  });
});

describe("the panel status override (decisions 5.3, 5.4)", () => {
  it("refuses 'em rota' for a delivery on a route that did not leave", async () => {
    const delivery = await prisma.delivery.findFirstOrThrow({
      where: { businessId: CARRIER, recipient_name: "Mercado Central" },
    });

    await prisma.route.create({
      data: {
        code: 900,
        scheduled_date: new Date("2026-09-17"),
        businessId: CARRIER,
        driverId: DRIVER,
        status: "RELEASED",
        stops: { create: [{ sequence: 1, deliveryId: delivery.id }] },
      },
    });

    const response = await call(
      "PATCH",
      `/delivery/update-delivery-status/${delivery.id}/business/${CARRIER}`,
      tokens.admin,
      { status: "IN_TRANSIT", reasonId: REASON },
    );

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).code).toBe("DELIVERY_ROUTE_NOT_STARTED");
  });

  it("refuses 'em rota' for a delivery nobody carries", async () => {
    const delivery = await prisma.delivery.findFirstOrThrow({
      where: { businessId: CARRIER, recipient_name: "Loja do Bairro" },
    });

    const response = await call(
      "PATCH",
      `/delivery/update-delivery-status/${delivery.id}/business/${CARRIER}`,
      tokens.admin,
      { status: "IN_TRANSIT", reasonId: REASON },
    );

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).code).toBe("DELIVERY_WITHOUT_DRIVER");
  });

  it("requires who received it to mark as delivered", async () => {
    const delivery = await prisma.delivery.findFirstOrThrow({
      where: { businessId: CARRIER, recipient_name: "Padaria Estrela" },
    });

    const response = await call(
      "PATCH",
      `/delivery/update-delivery-status/${delivery.id}/business/${CARRIER}`,
      tokens.admin,
      { status: "DELIVERED", reasonId: REASON },
    );

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).code).toBe("VALIDATION_ERROR");
  });
});

describe("an XML upload in Importações (decision 5.6)", () => {
  let importId: string;

  it("writes the row, stamps its deliveries and lists as NFE_XML", async () => {
    const response = await call("POST", `/delivery/import-xml/${CARRIER}`, tokens.admin, {
      scheduled_date: "2026-09-20",
      files: [
        { filename: "nota-1.xml", content: nfe(KEY(1), "11222333000181", "Indústria Doce") },
        { filename: "nota-2.xml", content: nfe(KEY(2), "11222333000181", "Indústria Doce") },
      ],
    });

    expect(response.statusCode).toBe(200);

    const summary = JSON.parse(response.body).data;

    expect(summary.imported).toBe(2);
    importId = summary.importId;

    const stamped = await prisma.delivery.findMany({ where: { importId } });

    expect(stamped).toHaveLength(2);
    expect(stamped[0].scheduled_date?.toISOString()).toBe("2026-09-20T00:00:00.000Z");

    const listed = ndjson(
      (await call("GET", "/import/list-imports?page=1&pageSize=10", tokens.admin)).body,
    );

    expect(listed.rows.find((row) => row.id === importId)).toMatchObject({
      source: "NFE_XML",
      status: "COMPLETED",
      imported: 2,
    });
  });

  it("is reversed like a spreadsheet, and tells the ERP each removed delivery is cancelled", async () => {
    const created = await prisma.delivery.findMany({
      where: { importId },
      select: { id: true },
    });

    const response = await call(
      "POST",
      `/import/reverse-import/${importId}/business/${CARRIER}`,
      tokens.admin,
    );

    expect(response.statusCode).toBe(200);
    expect(await prisma.delivery.count({ where: { importId } })).toBe(0);

    const cancelled = await prisma.webhookDelivery.findMany({
      where: { businessId: CARRIER, topic: "delivery.cancelled" },
    });

    expect(
      cancelled
        .map((row) => (row.payload as { data?: { delivery_id?: string } }).data?.delivery_id)
        .sort(),
    ).toEqual(created.map((row) => row.id).sort());
  });
});

describe("the shipper catalogue", () => {
  it("refuses a second shipper with the same CNPJ (409), and an invalid CNPJ (400)", async () => {
    const first = await call("POST", `/shipper/create-shipper/${CARRIER}`, tokens.admin, {
      name: "Matriz Ltda",
      cnpj: "11.444.777/0001-61",
    });

    expect(first.statusCode).toBe(201);

    const twin = await call("POST", `/shipper/create-shipper/${CARRIER}`, tokens.admin, {
      name: "Filial Ltda",
      cnpj: "11444777000161",
    });

    expect(twin.statusCode).toBe(409);
    expect(JSON.parse(twin.body).code).toBe("SHIPPER_CNPJ_TAKEN");

    const invalid = await call("POST", `/shipper/create-shipper/${CARRIER}`, tokens.admin, {
      name: "CNPJ errado",
      cnpj: "11444777000162",
    });

    expect(invalid.statusCode).toBe(400);
  });

  it("searches the picker on the server, active shippers only", async () => {
    const found = ndjson(
      (
        await call(
          "GET",
          `/shipper/search-shipper-business?businessId=${CARRIER}&search=bebidas`,
          tokens.admin,
        )
      ).body,
    );

    expect(found.rows.map((row) => row.name)).toEqual(["Bebidas Norte"]);

    const retired = ndjson(
      (
        await call(
          "GET",
          `/shipper/search-shipper-business?businessId=${CARRIER}&search=desativado`,
          tokens.admin,
        )
      ).body,
    );

    expect(retired.rows).toEqual([]);
  });

  it("finds a shipper by its CNPJ typed with the mask", async () => {
    // The column holds digits; the dispatcher types what is printed on the
    // invoice. The digits-only rewrite of the term stripped the letter "D"
    // instead of the non-digits, so a masked CNPJ matched nothing.
    await prisma.shipper.create({
      data: {
        name: "Laticínios Oeste",
        cnpj: "90123456000170",
        businessId: CARRIER,
      },
    });

    const found = ndjson(
      (
        await call(
          "GET",
          `/shipper/search-shipper-business?businessId=${CARRIER}&search=${encodeURIComponent("90.123.456/0001-70")}`,
          tokens.admin,
        )
      ).body,
    );

    expect(found.rows.map((row) => row.name)).toEqual(["Laticínios Oeste"]);
  });

  it("does not turn a name with a digit into a CNPJ search", async () => {
    // Every term with a digit was rewritten to its digits, so "Loja 2" also
    // searched CNPJs for "2": the list and the picker returned nearly every
    // shipper with a CNPJ, the one typed last.
    await prisma.shipper.createMany({
      data: [
        { name: "Loja 2 Irmãos", cnpj: "45723174000110", businessId: CARRIER },
        { name: "Distribuidora Leste", cnpj: "22333444000181", businessId: CARRIER },
      ],
    });

    const term = encodeURIComponent("Loja 2");

    const listed = ndjson(
      (
        await call(
          "GET",
          `/shipper/list-shipper?page=1&pageSize=10&search=${term}`,
          tokens.admin,
        )
      ).body,
    );

    expect(listed.rows.map((row) => row.name)).toEqual(["Loja 2 Irmãos"]);
    expect(listed.meta.searchMeta.total).toBe(1);

    const picked = ndjson(
      (
        await call(
          "GET",
          `/shipper/search-shipper-business?businessId=${CARRIER}&search=${term}`,
          tokens.admin,
        )
      ).body,
    );

    expect(picked.rows.map((row) => row.name)).toEqual(["Loja 2 Irmãos"]);

    // A masked CNPJ fragment is still a CNPJ search, on both.
    const fragment = encodeURIComponent("22.333.444");

    const byCnpj = ndjson(
      (
        await call(
          "GET",
          `/shipper/list-shipper?page=1&pageSize=10&search=${fragment}`,
          tokens.admin,
        )
      ).body,
    );

    expect(byCnpj.rows.map((row) => row.name)).toEqual(["Distribuidora Leste"]);

    const pickedByCnpj = ndjson(
      (
        await call(
          "GET",
          `/shipper/search-shipper-business?businessId=${CARRIER}&search=${fragment}`,
          tokens.admin,
        )
      ).body,
    );

    expect(pickedByCnpj.rows.map((row) => row.name)).toEqual(["Distribuidora Leste"]);
  });

  it("lets a suspended company delete nothing from its catalogue (DLV-SHP-7)", async () => {
    // The MASTER: a suspended company's own users do not even authenticate,
    // so the route's tenant guard is what stands between them and the delete.
    const shipper = await call(
      "DELETE",
      `/shipper/delete-shipper/${SUSPENDED_SHIPPER}/business/${SUSPENDED}`,
      tokens.master,
    );

    expect(shipper.statusCode).toBe(403);
    expect(JSON.parse(shipper.body).code).toBe("TENANT_INACTIVE");

    const type = await call(
      "DELETE",
      `/occurrence-type/delete-occurrence-type/${SUSPENDED_TYPE}/business/${SUSPENDED}`,
      tokens.master,
    );

    expect(type.statusCode).toBe(403);
    expect(JSON.parse(type.body).code).toBe("TENANT_INACTIVE");

    expect(await prisma.shipper.count({ where: { id: SUSPENDED_SHIPPER } })).toBe(1);
  });
});

describe("a driver reads only what is theirs (decision 4.4)", () => {
  it.each([
    "/shipper/list-shipper?page=1&pageSize=10",
    `/shipper/search-shipper-business?businessId=${CARRIER}`,
    "/import/list-imports?page=1&pageSize=10",
    "/import/download-template",
    "/delivery/message-templates",
    "/status-change-reason/list-status-change-reason?page=1&pageSize=10",
  ])("refuses %s to a driver token with PERMISSION_DENIED", async (url) => {
    const response = await call("GET", url, tokens.driver);

    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body).code).toBe("PERMISSION_DENIED");

    // The office still reads it.
    expect((await call("GET", url, tokens.admin)).statusCode).toBe(200);
  });
});

describe("the platform's own occurrence type (DLVP-OCC-3)", () => {
  it("never reaches the customer's tracking page", async () => {
    const delivery = await prisma.delivery.findFirstOrThrow({
      where: { businessId: CARRIER, recipient_name: "Farmácia Boa Saúde" },
    });

    const reporter = await prisma.user.findFirstOrThrow({
      where: { businessId: CARRIER, role: "BUSINESS_ADMIN" },
    });

    const [system, visible] = await Promise.all([
      prisma.occurrenceType.create({
        data: { name: "Tipo de sistema", is_system: true, businessId: CARRIER },
      }),
      prisma.occurrenceType.create({
        data: { name: "Destinatário ausente", businessId: CARRIER },
      }),
    ]);

    for (const type of [system, visible]) {
      await prisma.deliveryOccurrence.create({
        data: {
          deliveryId: delivery.id,
          businessId: CARRIER,
          occurrenceTypeId: type.id,
          reportedById: reporter.id,
        },
      });
    }

    const token = "f".repeat(64);

    await prisma.externalRecipient.create({
      data: {
        access_token: token,
        deliveryId: delivery.id,
        businessId: CARRIER,
        telephone: "11999999999",
      },
    });

    const response = await app.inject({ method: "GET", url: `/public/track/${token}` });

    expect(response.statusCode).toBe(200);

    const titles = JSON.parse(response.body).data.events.map(
      (event: { title: string }) => event.title,
    );

    expect(titles).toContain("Destinatário ausente");
    expect(titles).not.toContain("Tipo de sistema");

    // The carrier's zone rides along, so the page prints its instants on
    // the carrier's clock and not the server's UTC (decision 1.1).
    expect(JSON.parse(response.body).data.timeZone).toBe("America/Sao_Paulo");
  });

  it("shows a request for the tower only once it is approved (decision 6.3)", async () => {
    // Regression: the page read every NOT_DELIVERED occurrence, so the
    // person waiting saw a request still pending, one the tower denied and
    // one closed without a decision, as if each had happened to the delivery.
    const delivery = await prisma.delivery.create({
      data: {
        recipient_name: "Mercado da Esquina",
        city: "São Paulo",
        uf: "SP",
        street: "Rua do Mercado",
        businessId: CARRIER,
        shipperId: SHIPPER,
      },
    });

    const reporter = await prisma.user.findFirstOrThrow({
      where: { businessId: CARRIER, role: "BUSINESS_ADMIN" },
    });

    const statuses = ["NOT_REQUIRED", "APPROVED", "PENDING", "DENIED", "SUPERSEDED"] as const;

    for (const status of statuses) {
      const type = await prisma.occurrenceType.create({
        data: { name: `Pedido ${status}`, businessId: CARRIER, requires_authorization: status !== "NOT_REQUIRED" },
      });

      await prisma.deliveryOccurrence.create({
        data: {
          deliveryId: delivery.id,
          businessId: CARRIER,
          occurrenceTypeId: type.id,
          reportedById: reporter.id,
          authorization_status: status,
        },
      });
    }

    const token = "e".repeat(64);

    await prisma.externalRecipient.create({
      data: { access_token: token, deliveryId: delivery.id, businessId: CARRIER, telephone: "11999999999" },
    });

    const response = await app.inject({ method: "GET", url: `/public/track/${token}` });

    expect(response.statusCode).toBe(200);

    const titles = JSON.parse(response.body).data.events.map((event: { title: string }) => event.title);

    expect(titles.filter((title: string) => title.startsWith("Pedido ")).sort()).toEqual([
      "Pedido APPROVED",
      "Pedido NOT_REQUIRED",
    ]);

    // The proof PDF reads the same set: a pending, denied or superseded
    // request is not something that happened to the delivery either.
    const { ProofDocumentRepository } = await import(
      "@/modules/delivery/repositories/proof-document-repository"
    );
    const source = await new ProofDocumentRepository(prisma).loadSource(delivery.id, CARRIER);

    expect(source!.occurrences.map((occurrence) => occurrence.typeName).sort()).toEqual([
      "Pedido APPROVED",
      "Pedido NOT_REQUIRED",
    ]);
  });

  it("is created as a system type and never offered to the driver", async () => {
    const repository = new OccurrenceTypeRepository(prisma);

    await prisma.occurrenceType.create({
      data: { name: "Endereço não encontrado", businessId: CARRIER },
    });

    const system = await repository.ensureByName(CARRIER, {
      name: "Comprovante rejeitado",
      description: "Registrado pela auditoria de comprovantes.",
      blocks_delivery: false,
      requires_photo: false,
    });

    const row = await prisma.occurrenceType.findUniqueOrThrow({
      where: { id: system.id },
    });

    expect(row.is_system).toBe(true);

    const offered = await repository.listActiveOccurrenceTypes(CARRIER);

    expect(offered.map((type) => type.id)).not.toContain(system.id);
    expect(offered.map((type) => type.name)).toContain("Endereço não encontrado");
  });
});
