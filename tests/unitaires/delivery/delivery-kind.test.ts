import { beforeEach, describe, expect, it, vi } from "vitest";

import { UpdateDeliveryUseCase } from "@/modules/delivery/usecases/update-delivery/update-delivery-usecase";
import { CreateDeliveryUseCase } from "@/modules/delivery/usecases/create-delivery/create-delivery-usecase";
import { ImportDeliverySpreadsheetUseCase } from "@/modules/import/usecases/import-delivery-spreadsheet/import-delivery-spreadsheet-usecase";

import { InMemoryDeliveryRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-repository";
import { InMemoryShipperRepository } from "@/modules/shipper/repositories/in-memory/in-memory-shipper-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";
import { InMemoryImportRepository } from "@/modules/import/repositories/in-memory/in-memory-import-repository";
import { InMemoryRouteRepository } from "@/modules/route/repositories/in-memory/in-memory-route-repository";
import { InMemoryDriverRepository } from "@/modules/driver/repositories/in-memory/in-memory-driver-repository";
import { InMemoryVehicleRepository } from "@/modules/vehicle/repositories/in-memory/in-memory-vehicle-repository";

import { InMemoryWebhookFanOutService } from "@/shared/integration/in-memory/in-memory-webhook-fan-out-service";
import { BUSINESS_COLUMN_DEFAULTS } from "@/shared/in-memory/column-defaults";
import { parseDeliverySpreadsheet } from "@/shared/delivery/spreadsheet-parser";
import { toPublicDelivery } from "@/shared/integration/public-shapes";
import { isSameSubmission } from "@/modules/integration/usecases/create-delivery/replay-fingerprint";

import { createDeliverySchema } from "@/schemas/create-delivery-schema";
import { updateDeliverySchema } from "@/schemas/update-delivery-schema";
import { parseIntegrationDeliveryBody } from "@/schemas/create-integration-delivery-schema";

import type { NotificationService } from "@/shared/services/notification-service";
import type { User } from "@/modules/user/dtos/user-dto";
import type { Shipper } from "@/modules/shipper/dtos/shipper-dto";
import type { Business } from "@/modules/business/dtos/business-dto";

vi.mock("@/../infra/database", () => ({
  default: {
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run({}),
  },
}));

/**
 * "Entrega" or "Ordem de serviço" (meeting of 14/10/2026): every new record
 * has a type. A service order is a stop to perform a service at the address
 * (collecting returnable baskets), not the fleet module's service order.
 *
 * Optional on the wire so every caller written before it keeps working:
 * absent is DELIVERY. The panel and the public API write DELIVERY or
 * SERVICE_ORDER; PICKUP stays readable, written only by the spreadsheet's
 * "coleta" — which the parser always read and nothing ever wrote.
 */
const BUSINESS = "018f0000-0000-7000-8000-0000000009b1";
const OPERATOR = "018f0000-0000-7000-8000-0000000009a1";
const SHIPPER = "018f0000-0000-7000-8000-0000000009f1";

const BODY = {
  shipperId: SHIPPER,
  recipient_name: "Mercado Central",
  cep: "01001000",
  city: "São Paulo",
  uf: "SP",
  street: "Rua Um",
};

let deliveries: InMemoryDeliveryRepository;
let create: CreateDeliveryUseCase;
let update: UpdateDeliveryUseCase;
let importSpreadsheet: ImportDeliverySpreadsheetUseCase;

beforeEach(() => {
  const users = new InMemoryUserRepository();
  const businesses = new InMemoryBusinessRepository();
  const shippers = new InMemoryShipperRepository();

  deliveries = new InMemoryDeliveryRepository();

  users.user.push({
    id: OPERATOR,
    name: "Despachante",
    role: "BUSINESS_ADMIN",
    businessId: BUSINESS,
  } as User);
  businesses.business.push({
    ...BUSINESS_COLUMN_DEFAULTS,
    id: BUSINESS,
    is_active: true,
  } as Business);
  shippers.shippers.push({
    id: SHIPPER,
    name: "Ativo",
    businessId: BUSINESS,
    is_active: true,
  } as Shipper);

  const notifications = {
    createActivityIfEnabled: async () => undefined,
  } as unknown as NotificationService;

  create = new CreateDeliveryUseCase(
    users,
    businesses,
    shippers,
    deliveries,
    notifications,
    new InMemoryWebhookFanOutService().asService(),
  );
  update = new UpdateDeliveryUseCase(users, shippers, deliveries);
  importSpreadsheet = new ImportDeliverySpreadsheetUseCase(
    users,
    businesses,
    shippers,
    deliveries,
    new InMemoryRouteRepository(deliveries.deliveries as never),
    new InMemoryDriverRepository(),
    new InMemoryVehicleRepository(),
    new InMemoryImportRepository(),
    notifications,
    new InMemoryWebhookFanOutService().asService(),
  );
});

async function created(body: Record<string, unknown>) {
  const delivery = await create.execute(
    { ...createDeliverySchema.parse(body), businessId: BUSINESS },
    OPERATOR,
  );

  return deliveries.findDeliveryById(delivery.id!);
}

describe("the panel's create and edit", () => {
  it("stores a service order as one", async () => {
    expect(await created({ ...BODY, kind: "SERVICE_ORDER" })).toMatchObject({
      kind: "SERVICE_ORDER",
    });
  });

  it("reads a create without a type as a delivery, as before the type existed", async () => {
    expect(createDeliverySchema.parse(BODY).kind).toBeUndefined();
    expect(await created(BODY)).toMatchObject({ kind: "DELIVERY" });
  });

  it("refuses PICKUP and anything else, in Portuguese", () => {
    for (const kind of ["PICKUP", "ORDEM"]) {
      const result = createDeliverySchema.safeParse({ ...BODY, kind });

      expect(result.success).toBe(false);
      expect(!result.success && result.error.issues[0].message).toBe(
        "Tipo inválido. Use DELIVERY (entrega) ou SERVICE_ORDER (ordem de serviço).",
      );
    }
  });

  it("changes the type on an edit, and keeps it when the edit leaves it out", async () => {
    const row = await created(BODY);
    const edit = (body: Record<string, unknown>) =>
      update.execute({
        userId: OPERATOR,
        businessId: BUSINESS,
        deliveryId: row!.id!,
        deliveryData: updateDeliverySchema.parse(body),
      });

    await edit({ kind: "SERVICE_ORDER" });
    expect((await deliveries.findDeliveryById(row!.id!))?.kind).toBe(
      "SERVICE_ORDER",
    );

    await edit({ notes: "Portão azul" });
    expect((await deliveries.findDeliveryById(row!.id!))?.kind).toBe(
      "SERVICE_ORDER",
    );
  });
});

describe("the public API's create", () => {
  const body = {
    shipper_id: SHIPPER,
    recipient_name: "Mercado Central",
    cep: "01001-000",
    city: "São Paulo",
    uf: "sp",
    street: "Rua Um",
  };

  it("takes the type, absent meaning DELIVERY, and refuses PICKUP", () => {
    expect(
      parseIntegrationDeliveryBody({ ...body, kind: "SERVICE_ORDER" }).kind,
    ).toBe("SERVICE_ORDER");
    expect(parseIntegrationDeliveryBody(body).kind).toBeUndefined();
    expect(() =>
      parseIntegrationDeliveryBody({ ...body, kind: "PICKUP" }),
    ).toThrow(/Tipo inválido/);
  });

  it("answers the type in the public shape", () => {
    const row = {
      id: "d-1",
      code: null,
      invoice_key: null,
      invoice_number: null,
      status: "PENDING",
      recipient_name: "Mercado Central",
      recipient_document: null,
      street: "Rua Um",
      address_number: null,
      complement: null,
      neighborhood: null,
      city: "São Paulo",
      uf: "SP",
      cep: "01001000",
      scheduled_date: null,
      delivered_at: null,
      received_by: null,
      created_at: new Date(),
      updated_at: new Date(),
    };

    expect(toPublicDelivery({ ...row, kind: "SERVICE_ORDER" }).kind).toBe(
      "SERVICE_ORDER",
    );
    expect(toPublicDelivery(row).kind).toBe("DELIVERY");
  });

  it("treats a retry with another type as another body (409), and an absent type as DELIVERY", () => {
    const stored = {
      shipperId: SHIPPER,
      recipient_name: "Mercado Central",
      city: "São Paulo",
      uf: "SP",
      street: "Rua Um",
      scheduled_date: null,
      items: [],
      apiKeyId: "key-1",
      kind: "DELIVERY",
    };
    const draft = {
      shipperId: SHIPPER,
      recipient_name: "Mercado Central",
      city: "São Paulo",
      uf: "SP",
      street: "Rua Um",
    };

    expect(isSameSubmission(draft, stored)).toBe(true);
    expect(isSameSubmission({ ...draft, kind: "SERVICE_ORDER" }, stored)).toBe(
      false,
    );
  });
});

describe("the spreadsheet's Tipo column", () => {
  const HEADER = ["Tipo", "Destinatário", "CEP", "Cidade", "UF", "Logradouro"];
  const GOOD = [
    "Padaria Central",
    "01001000",
    "São Paulo",
    "SP",
    "Praça da Sé",
  ];

  it("reads the service order's spellings", () => {
    for (const value of [
      "Ordem de serviço",
      "ORDEM DE SERVICO",
      "OS",
      "O.S.",
    ]) {
      const result = parseDeliverySpreadsheet([HEADER, [value, ...GOOD]]);

      expect(result.errors).toEqual([]);
      expect(result.rows[0].kind).toBe("SERVICE_ORDER");
    }
  });

  it("names the three words when it does not know one", () => {
    const result = parseDeliverySpreadsheet([HEADER, ["devolução", ...GOOD]]);

    expect(result.errors[0]).toMatchObject({
      column: "Tipo",
      message: 'Use "entrega", "ordem de serviço" ou "coleta".',
    });
  });

  it("writes the type of each row, blank being a delivery", async () => {
    const csv = [
      HEADER,
      ["", ...GOOD],
      ["ordem de serviço", "Mercado Novo", ...GOOD.slice(1)],
      ["coleta", "Depósito Sul", ...GOOD.slice(1)],
    ]
      .map((row) => row.map((cell) => `"${cell}"`).join(";"))
      .join("\n");

    const record = await importSpreadsheet.execute({
      userId: OPERATOR,
      businessId: BUSINESS,
      filename: "tipos.csv",
      content: Buffer.from(csv, "utf8").toString("base64"),
      shipperId: SHIPPER,
    });

    expect(record.imported).toBe(3);
    expect(
      deliveries.deliveries.map((row) => [row.recipient_name, row.kind]),
    ).toEqual([
      ["Padaria Central", "DELIVERY"],
      ["Mercado Novo", "SERVICE_ORDER"],
      ["Depósito Sul", "PICKUP"],
    ]);
  });
});
