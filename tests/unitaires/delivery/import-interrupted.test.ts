import { describe, expect, it, vi } from "vitest";

import { ImportDeliverySpreadsheetUseCase } from "@/modules/import/usecases/import-delivery-spreadsheet/import-delivery-spreadsheet-usecase";
import { ReverseImportUseCase } from "@/modules/import/usecases/reverse-import/reverse-import-usecase";

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
import type { Shipper } from "@/modules/shipper/dtos/shipper-dto";
import { BUSINESS_COLUMN_DEFAULTS } from "@/shared/in-memory/column-defaults";

vi.mock("@/../infra/database", () => ({
  default: {
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run({}),
  },
}));

/**
 * An upload that fails halfway (IDEMP-10).
 *
 * The record is opened IN_PROGRESS before the first row, so that a failure
 * halfway leaves an upload the operator can still undo. But nothing ever
 * closed it except the happy path, and the undo refuses IN_PROGRESS: one pool
 * timeout on row 3 of 4 left two deliveries stamped with an import that could
 * never be reversed — the opposite of what the status was introduced for.
 */
const BUSINESS = "018f0000-0000-7000-8000-00000000000b";
const DISPATCHER = "018f0000-0000-7000-8000-0000000000a1";
const SHIPPER = "018f0000-0000-7000-8000-0000000000f1";

const HEADER = ["Destinatário", "CEP", "Cidade", "UF", "Logradouro", "Pedido"];

function upload(rows: string[][]): string {
  return Buffer.from(
    [HEADER, ...rows]
      .map((row) => row.map((cell) => `"${cell}"`).join(";"))
      .join("\n"),
    "utf8",
  ).toString("base64");
}

function makeContext() {
  const userRepository = new InMemoryUserRepository();
  const businessRepository = new InMemoryBusinessRepository();
  const shipperRepository = new InMemoryShipperRepository();
  const deliveryRepository = new InMemoryDeliveryRepository();
  const routeRepository = new InMemoryRouteRepository(
    deliveryRepository.deliveries as never,
  );
  const importRepository = new InMemoryImportRepository();

  userRepository.user.push({
    id: DISPATCHER,
    role: "BUSINESS_ADMIN",
    businessId: BUSINESS,
  } as User);

  businessRepository.business.push({
    ...BUSINESS_COLUMN_DEFAULTS,
    id: BUSINESS,
    is_active: true,
  } as Business);

  shipperRepository.shippers.push({
    id: SHIPPER,
    name: "Embarcador",
    businessId: BUSINESS,
  } as Shipper);

  const notifications = {
    createActivityIfEnabled: async () => {},
  } as unknown as NotificationService;

  return {
    deliveryRepository,
    importRepository,
    importSpreadsheet: new ImportDeliverySpreadsheetUseCase(
      userRepository,
      businessRepository,
      shipperRepository,
      deliveryRepository,
      routeRepository,
      new InMemoryDriverRepository(),
      new InMemoryVehicleRepository(),
      importRepository,
      notifications,
      new InMemoryWebhookFanOutService().asService(),
    ),
    reverse: new ReverseImportUseCase(
      userRepository,
      importRepository,
      notifications,
      new InMemoryWebhookFanOutService().asService(),
    ),
  };
}

describe("an upload interrupted by a server failure halfway", () => {
  it("is closed with what it did, and can be undone", async () => {
    const context = makeContext();

    // A pool timeout on the third order's duplicate check (line 4 of the
    // sheet), the lookup the loop makes before any transaction opens.
    const lookup = context.deliveryRepository.findDeliveryByShipperAndCode.bind(
      context.deliveryRepository,
    );

    context.deliveryRepository.findDeliveryByShipperAndCode = async (
      ...args: Parameters<typeof lookup>
    ) => {
      const [, , code, tx] = args as unknown[];

      if (code === "P-3" && !tx) {
        throw new Error("P2024: Timed out fetching a new connection");
      }

      return lookup(...args);
    };

    await expect(
      context.importSpreadsheet.execute({
        userId: DISPATCHER,
        businessId: BUSINESS,
        filename: "pedidos.csv",
        shipperId: SHIPPER,
        content: upload([
          ["Cliente 1", "01001000", "São Paulo", "SP", "Rua 1", "P-1"],
          ["Cliente 2", "01001000", "São Paulo", "SP", "Rua 2", "P-2"],
          ["Cliente 3", "01001000", "São Paulo", "SP", "Rua 3", "P-3"],
          ["Cliente 4", "01001000", "São Paulo", "SP", "Rua 4", "P-4"],
        ]),
      }),
    ).rejects.toThrow();

    const [record] = context.importRepository.imports;

    expect(record.status).toBe("COMPLETED");
    expect(context.deliveryRepository.deliveries).toHaveLength(2);
    expect(record.imported).toBe(2);

    // The line it stopped at says so, and what to do about it.
    const interruption = record.report.rows.find(
      (row) => row.outcome === "invalid",
    );

    expect(interruption?.line).toBe(4);
    expect(interruption?.message).toContain("interrompida");

    await expect(
      context.reverse.execute({
        userId: DISPATCHER,
        businessId: BUSINESS,
        importId: record.id,
      }),
    ).resolves.toBeDefined();
  });

  it("still refuses to undo an upload that is really running", async () => {
    const context = makeContext();

    const running = await context.importRepository.createImport({
      source: "SPREADSHEET",
      filename: "pedidos.csv",
      businessId: BUSINESS,
      performedById: DISPATCHER,
    });

    await expect(
      context.reverse.execute({
        userId: DISPATCHER,
        businessId: BUSINESS,
        importId: running.id,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "IMPORT_IN_PROGRESS" });
  });
});
