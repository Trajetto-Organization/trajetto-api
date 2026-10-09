import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { container } from "tsyringe";

import { ImportDeliverySpreadsheetUseCase } from "@/modules/import/usecases/import-delivery-spreadsheet/import-delivery-spreadsheet-usecase";
import { DeliveryRepository } from "@/modules/delivery/repositories/delivery-repository";

import type { Delivery } from "@/modules/delivery/dtos/delivery-dto";
import type { Prisma } from "@prisma/client";

/**
 * Two uploads of the same order-only sheet, at the same time (IDEMP-04).
 *
 * A company without NF-e keys is deduplicated by (shipper, pedido), and no
 * unique index backs that pair: repeated manual order codes can be legitimate
 * (ADR 0006). The check in the application is all there is, so two uploads
 * whose checks both run before either insert commits used to create every
 * order twice, and two routes with the same stops for the same driver.
 *
 * The race is made deterministic: the pre-check (the lookup outside any
 * transaction) of each order waits until both uploads have reached it. On the
 * old code both then inserted. The lookup a writer repeats under its
 * transaction-scoped lock is not held back, so the barrier cannot deadlock
 * the fix it is testing.
 */
const prisma = new PrismaClient();

const CARRIER = "018fdc70-0000-7000-8000-00000000000a";
const ADMIN = "018fdc70-0000-7000-8000-0000000000a1";
const SHIPPER = "018fdc70-0000-7000-8000-0000000000f1";
const JOAO = "018fdc70-0000-7000-8000-0000000000d1";

const JOAO_CNH = `7${Date.now().toString().slice(-10)}`;

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

/** Holds each order's pre-check until the other upload asks for it too. */
class RacingDeliveryRepository extends DeliveryRepository {
  private arrivals = new Map<string, { count: number; release: () => void; gate: Promise<void> }>();

  async findDeliveryByShipperAndCode(
    businessId: string,
    shipperId: string,
    code: string,
    tx?: Prisma.TransactionClient,
  ): Promise<Delivery | null> {
    if (!tx) {
      let entry = this.arrivals.get(code);

      if (!entry) {
        let release = () => {};
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });

        entry = { count: 0, release, gate };
        this.arrivals.set(code, entry);
      }

      entry.count += 1;

      if (entry.count >= 2) entry.release();

      await Promise.race([
        entry.gate,
        new Promise((resolve) => setTimeout(resolve, 500)),
      ]);
    }

    return super.findDeliveryByShipperAndCode(businessId, shipperId, code, tx);
  }
}

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora da Corrida",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(59000000000000 + Math.floor(Math.random() * 9000000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `corrida-${randomUUID()}@exemplo.com.br`,
    },
  });

  await prisma.businessEntitlement.create({
    data: { businessId: CARRIER, module: "DELIVERIES", enabled: true },
  });

  await prisma.shipper.create({
    data: { id: SHIPPER, name: "Embarcador", businessId: CARRIER },
  });

  await prisma.driver.create({
    data: {
      id: JOAO,
      name: "João",
      birth_date: new Date("1990-01-01"),
      cnh: JOAO_CNH,
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

  // Registers the tsyringe container the use cases resolve from.
  await import("@/http");
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
});

function racingUseCase(repository: RacingDeliveryRepository) {
  const child = container.createChildContainer();

  child.registerInstance("DeliveryRepository", repository);

  return child.resolve(ImportDeliverySpreadsheetUseCase);
}

describe("two uploads of the same order-only sheet at once", () => {
  it("creates each order once, and routes it once", async () => {
    const orders = Array.from({ length: 12 }, (_, index) => `RACE-${index + 1}`);

    const content = csv(
      orders.map((code, index) => [
        `Cliente ${index + 1}`,
        "01001000",
        "São Paulo",
        "SP",
        `Rua ${index + 1}`,
        code,
        "Zona Norte",
        JOAO_CNH,
      ]),
    );

    const repository = new RacingDeliveryRepository();

    const request = {
      userId: ADMIN,
      businessId: CARRIER,
      filename: "pedidos.csv",
      shipperId: SHIPPER,
      content,
    };

    const [first, second] = await Promise.all([
      racingUseCase(repository).execute(request),
      racingUseCase(repository).execute(request),
    ]);

    const perOrder = await prisma.delivery.groupBy({
      by: ["code"],
      where: { businessId: CARRIER, shipperId: SHIPPER, code: { in: orders } },
      _count: { _all: true },
    });

    expect(perOrder).toHaveLength(orders.length);

    for (const group of perOrder) {
      expect(group._count._all).toBe(1);
    }

    expect(first.report.imported + second.report.imported).toBe(orders.length);
    expect(first.report.duplicated + second.report.duplicated).toBe(
      orders.length,
    );

    // The loser is told it was the ORDER that already existed, not an invoice.
    const duplicatedRows = [...first.report.rows, ...second.report.rows].filter(
      (row) => row.outcome === "duplicated",
    );

    for (const row of duplicatedRows) {
      expect(row.message).toBe(
        "Este pedido já havia sido importado para este embarcador.",
      );
    }

    // Every order sits on exactly one open stop: the two uploads' routes
    // partition the sheet between them instead of repeating it.
    const stops = await prisma.routeStop.count({
      where: { delivery: { businessId: CARRIER, code: { in: orders } } },
    });

    expect(stops).toBe(orders.length);
  }, 60_000);
});
