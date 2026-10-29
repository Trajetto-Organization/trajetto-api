import { beforeEach, describe, expect, it, vi } from "vitest";

import { ImportDeliverySpreadsheetUseCase } from "@/modules/import/usecases/import-delivery-spreadsheet/import-delivery-spreadsheet-usecase";

import { InMemoryImportRepository } from "@/modules/import/repositories/in-memory/in-memory-import-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";
import { InMemoryShipperRepository } from "@/modules/shipper/repositories/in-memory/in-memory-shipper-repository";
import { InMemoryDeliveryRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-repository";
import { InMemoryRouteRepository } from "@/modules/route/repositories/in-memory/in-memory-route-repository";
import { InMemoryDriverRepository } from "@/modules/driver/repositories/in-memory/in-memory-driver-repository";
import { InMemoryVehicleRepository } from "@/modules/vehicle/repositories/in-memory/in-memory-vehicle-repository";

import { InMemoryWebhookFanOutService } from "@/shared/integration/in-memory/in-memory-webhook-fan-out-service";

import type { NotificationService } from "@/shared/services/notification-service";
import type { User } from "@/modules/user/dtos/user-dto";
import type { Business } from "@/modules/business/dtos/business-dto";
import type { Driver } from "@/modules/driver/dtos/driver-dto";
import type { Vehicle } from "@/modules/vehicle/dtos/vehicle-dto";
import type { Shipper } from "@/modules/shipper/dtos/shipper-dto";
import { BUSINESS_COLUMN_DEFAULTS } from "@/shared/in-memory/column-defaults";

vi.mock("@/../infra/database", () => ({
  default: {
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run({}),
  },
}));

/**
 * The spreadsheet is the first client's way in without an integration, and
 * it said nothing to the integrations the same company already had: every
 * row became a delivery without `delivery.created`, and the route columns put
 * each one in a driver's hands without `delivery.assigned`.
 */
const BUSINESS = "018f0000-0000-7000-8000-00000000050b";
const DISPATCHER = "018f0000-0000-7000-8000-0000000005a1";
const SHIPPER = "018f0000-0000-7000-8000-0000000005f1";
const DRIVER = "018f0000-0000-7000-8000-0000000005d1";
const VEHICLE = "018f0000-0000-7000-8000-0000000005e1";

const CNH = "01234567890";
const PLATE = "ABC1D23";

const HEADER = [
  "Destinatário",
  "CEP",
  "Cidade",
  "UF",
  "Logradouro",
  "Chave da NF-e",
  "Pedido",
  "Rota",
  "CNH do motorista",
  "Placa do veículo",
];

function line(recipient: string, code: string, route = "") {
  return [
    recipient,
    "01001000",
    "São Paulo",
    "SP",
    "Praça da Sé",
    "",
    code,
    route,
    route ? CNH : "",
    route ? PLATE : "",
  ];
}

function upload(rows: string[][]): string {
  const text = [HEADER, ...rows]
    .map((row) => row.map((cell) => `"${cell}"`).join(";"))
    .join("\n");

  return Buffer.from(text, "utf8").toString("base64");
}

let webhooks: InMemoryWebhookFanOutService;
let deliveries: InMemoryDeliveryRepository;
let routes: InMemoryRouteRepository;
let importSpreadsheet: ImportDeliverySpreadsheetUseCase;

beforeEach(() => {
  webhooks = new InMemoryWebhookFanOutService();

  const users = new InMemoryUserRepository();
  const businesses = new InMemoryBusinessRepository();
  const shippers = new InMemoryShipperRepository();
  const drivers = new InMemoryDriverRepository();
  const vehicles = new InMemoryVehicleRepository();
  const imports = new InMemoryImportRepository();

  deliveries = new InMemoryDeliveryRepository();
  routes = new InMemoryRouteRepository(deliveries.deliveries as never);

  users.user.push({
    id: DISPATCHER,
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
    name: "Embarcador",
    businessId: BUSINESS,
  } as Shipper);

  drivers.drivers.push({
    id: DRIVER,
    name: "João Motorista",
    cnh: CNH,
    status: "ACTIVE",
    businessId: BUSINESS,
  } as Driver);

  vehicles.vehicles.push({
    id: VEHICLE,
    license_plate: PLATE,
    status: "ACTIVE",
    businessId: BUSINESS,
  } as Vehicle);

  importSpreadsheet = new ImportDeliverySpreadsheetUseCase(
    users,
    businesses,
    shippers,
    deliveries,
    routes,
    drivers,
    vehicles,
    imports,
    {
      createActivityIfEnabled: async () => undefined,
    } as unknown as NotificationService,
    webhooks.asService(),
  );
});

function run(rows: string[][]) {
  return importSpreadsheet.execute({
    userId: DISPATCHER,
    businessId: BUSINESS,
    filename: "entregas.csv",
    content: upload(rows),
    shipperId: SHIPPER,
  });
}

describe("a spreadsheet import", () => {
  it("announces each delivery it creates, in the write's transaction", async () => {
    const record = await run([
      line("Padaria Central", "P-1"),
      line("Mercado Novo", "P-2"),
      line("Açougue Bom", "P-3"),
    ]);

    expect(record.imported).toBe(3);

    const created = webhooks.forTopic("delivery.created");

    expect(created).toHaveLength(3);
    expect(created.map((event) => event.payload.code).sort()).toEqual([
      "P-1",
      "P-2",
      "P-3",
    ]);

    for (const event of created) {
      expect(event.businessId).toBe(BUSINESS);
      expect(event.transactional).toBe(true);
    }
  });

  it("announces the deliveries its route columns put in a driver's hands", async () => {
    await run([
      line("Primeira", "P-4", "Zona Sul"),
      line("Segunda", "P-5", "Zona Sul"),
      line("Sem rota", "P-6"),
    ]);

    const [route] = routes.routes;

    expect(route).toBeDefined();

    const assigned = webhooks.forTopic("delivery.assigned");

    expect(assigned.map((event) => event.payload.code).sort()).toEqual([
      "P-4",
      "P-5",
    ]);

    for (const event of assigned) {
      expect(event.transactional).toBe(true);
      expect(event.payload).toMatchObject({
        driver_id: DRIVER,
        vehicle_id: VEHICLE,
        route_id: route.id,
        route_code: route.code,
      });
    }
  });

  it("announces nothing for a row it refused as a duplicate", async () => {
    await run([line("Padaria Central", "P-7")]);

    webhooks.reset();

    const again = await run([line("Padaria Central", "P-7")]);

    expect(again.duplicated).toBe(1);
    expect(webhooks.forTopic("delivery.created")).toHaveLength(0);
  });
});
