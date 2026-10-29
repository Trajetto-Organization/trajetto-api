import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import { container } from "tsyringe";

import { ImportDeliveryXmlUseCase } from "@/modules/delivery/usecases/import-delivery-xml/import-delivery-xml-usecase";
import { ImportDeliverySpreadsheetUseCase } from "@/modules/import/usecases/import-delivery-spreadsheet/import-delivery-spreadsheet-usecase";
import { AddRouteStopsUseCase } from "@/modules/route/usecases/add-route-stops/add-route-stops-usecase";
import { UpdateRouteUseCase } from "@/modules/route/usecases/update-route/update-route-usecase";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * The published topics, through the real repositories and the real fan-out.
 *
 * `delivery.created` came only from the single-delivery form, and
 * `delivery.assigned` only from the route builder. The NF-e and spreadsheet
 * imports — the main way documents enter — adding stops to a route, and
 * swapping a route's driver all changed exactly what those topics publish,
 * in silence. Each now writes its webhook rows in the same transaction as the
 * fact, which is what this checks against Postgres: the rows exist, one per
 * document, carrying who holds it.
 */
const prisma = createPrismaClient();

const CARRIER = "018fdc60-0000-7000-8000-00000000000a";
const ADMIN = "018fdc60-0000-7000-8000-0000000000a1";
const SHIPPER = "018fdc60-0000-7000-8000-0000000000f1";
const JOAO = "018fdc60-0000-7000-8000-0000000000d1";
const MARIA = "018fdc60-0000-7000-8000-0000000000d2";

const JOAO_CNH = `9${Date.now().toString().slice(-10)}`;

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
  return Buffer.from(
    [HEADER, ...rows]
      .map((row) => row.map((cell) => `"${cell}"`).join(";"))
      .join("\n"),
    "utf8",
  ).toString("base64");
}

function nfe(accessKey: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">
  <NFe>
    <infNFe Id="NFe${accessKey}" versao="4.00">
      <ide><nNF>1234</nNF></ide>
      <emit><CNPJ>12345678000199</CNPJ><xNome>Industria Alimentos LTDA</xNome></emit>
      <dest>
        <CNPJ>98765432000188</CNPJ>
        <xNome>Mercado Central ME</xNome>
        <enderDest>
          <xLgr>Rua das Palmeiras</xLgr><nro>450</nro><xBairro>Centro</xBairro>
          <xMun>Campinas</xMun><UF>SP</UF><CEP>13010000</CEP>
        </enderDest>
      </dest>
      <det nItem="1"><prod><xProd>Leite</xProd><qCom>1</qCom><uCom>CX</uCom><vUnCom>4.5</vUnCom></prod></det>
    </infNFe>
  </NFe>
</nfeProc>`;
}

async function driver(id: string, name: string, cnh: string) {
  await prisma.driver.create({
    data: {
      id,
      name,
      birth_date: new Date("1990-01-01"),
      cnh,
      cpf: `cpf-${randomUUID().slice(0, 8)}`,
      rg: `rg-${randomUUID().slice(0, 8)}`,
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
}

/** The webhook rows written for a topic, their envelope's data. */
async function announced(topic: string) {
  const rows = await prisma.webhookDelivery.findMany({
    where: { businessId: CARRIER, topic },
    orderBy: { created_at: "asc" },
    select: { payload: true },
  });

  return rows.map(
    (row) => (row.payload as { data: Record<string, unknown> }).data,
  );
}

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora dos Tópicos",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(58000000000000 + Math.floor(Math.random() * 9000000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `topicos-${randomUUID()}@exemplo.com.br`,
    },
  });

  await prisma.businessEntitlement.create({
    data: { businessId: CARRIER, module: "DELIVERIES", enabled: true },
  });

  await prisma.shipper.create({
    data: { id: SHIPPER, name: "Embarcador", businessId: CARRIER },
  });

  await driver(JOAO, "João", JOAO_CNH);
  await driver(MARIA, "Maria", `8${Date.now().toString().slice(-10)}`);

  await prisma.user.create({
    data: {
      id: ADMIN,
      name: "Despachante",
      email: `despacho-${randomUUID()}@exemplo.com.br`,
      password: "nao-usado",
      role: "BUSINESS_ADMIN",
      businessId: CARRIER,
    },
  });

  // Subscribed to both families' document topics. Never called: the rows
  // are what is asserted, not the POST.
  await prisma.webhookEndpoint.create({
    data: {
      name: "ERP",
      url: "https://erp.exemplo.com.br/webhooks",
      secret: "whsec_teste",
      topics: ["delivery.created", "delivery.assigned"],
      businessId: CARRIER,
    },
  });

  // Registers the tsyringe container the use cases resolve from.
  await import("@/http");
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
});

let routeId = "";

describe("documents entering through an import", () => {
  it("the spreadsheet announces each delivery, and each one its route hands over", async () => {
    const record = await container
      .resolve(ImportDeliverySpreadsheetUseCase)
      .execute({
        userId: ADMIN,
        businessId: CARRIER,
        filename: "entregas.csv",
        shipperId: SHIPPER,
        content: csv([
          [
            "Padaria",
            "01001000",
            "São Paulo",
            "SP",
            "Rua A",
            "P-1",
            "Zona Sul",
            JOAO_CNH,
          ],
          [
            "Mercado",
            "01001000",
            "São Paulo",
            "SP",
            "Rua B",
            "P-2",
            "Zona Sul",
            JOAO_CNH,
          ],
        ]),
      });

    expect(record.imported).toBe(2);
    expect(record.report.routes).toHaveLength(1);

    routeId = record.report.routes[0].id;

    const created = await announced("delivery.created");

    expect(created.map((data) => data.code).sort()).toEqual(["P-1", "P-2"]);

    const assigned = await announced("delivery.assigned");

    expect(assigned).toHaveLength(2);

    for (const data of assigned) {
      expect(data).toMatchObject({ driver_id: JOAO, route_id: routeId });
    }
  });

  it("the NF-e import announces the delivery with its key", async () => {
    const key =
      `3524061234567800019955001${Date.now().toString().slice(-13)}000001`.slice(
        0,
        44,
      );

    const summary = await container.resolve(ImportDeliveryXmlUseCase).execute({
      userId: ADMIN,
      businessId: CARRIER,
      shipperId: SHIPPER,
      files: [{ filename: "nota.xml", content: nfe(key) }],
    });

    expect(summary.imported).toBe(1);

    const created = await announced("delivery.created");

    expect(created.some((data) => data.invoice_key === key)).toBe(true);

    // The same file again is a duplicate, and says nothing new.
    const before = created.length;

    await container.resolve(ImportDeliveryXmlUseCase).execute({
      userId: ADMIN,
      businessId: CARRIER,
      shipperId: SHIPPER,
      files: [{ filename: "nota.xml", content: nfe(key) }],
    });

    expect(await announced("delivery.created")).toHaveLength(before);
  });
});

describe("a route changing hands", () => {
  it("adding a stop announces it with the route's driver", async () => {
    const delivery = await prisma.delivery.create({
      data: {
        recipient_name: "Açougue",
        city: "São Paulo",
        uf: "SP",
        street: "Rua C",
        code: "P-3",
        businessId: CARRIER,
        shipperId: SHIPPER,
      },
    });

    await container.resolve(AddRouteStopsUseCase).execute({
      userId: ADMIN,
      businessId: CARRIER,
      routeId,
      deliveryIds: [delivery.id],
    });

    const assigned = await announced("delivery.assigned");

    expect(assigned.filter((data) => data.delivery_id === delivery.id)).toEqual(
      [
        expect.objectContaining({
          driver_id: JOAO,
          route_id: routeId,
          code: "P-3",
        }),
      ],
    );
  });

  it("swapping the driver announces every open stop with the new one", async () => {
    const before = (await announced("delivery.assigned")).length;

    await container.resolve(UpdateRouteUseCase).execute({
      userId: ADMIN,
      businessId: CARRIER,
      routeId,
      driverId: MARIA,
    });

    const assigned = (await announced("delivery.assigned")).slice(before);

    expect(assigned.map((data) => data.code).sort()).toEqual([
      "P-1",
      "P-2",
      "P-3",
    ]);

    for (const data of assigned) {
      expect(data).toMatchObject({ driver_id: MARIA, route_id: routeId });
    }

    // And the deliveries say so too, in the same commit.
    const mirrored = await prisma.delivery.findMany({
      where: { businessId: CARRIER, code: { in: ["P-1", "P-2", "P-3"] } },
      select: { driverId: true },
    });

    expect(mirrored.every((row) => row.driverId === MARIA)).toBe(true);
  });
});
