import { describe, expect, it, vi } from "vitest";

// A file that passes the cheap inspection and still cannot be loaded: the
// request is long answered, so the record has to say it.
vi.mock("@/shared/delivery/spreadsheet-reader", () => ({
  inspectSpreadsheet: () => undefined,
  readSpreadsheet: async () => {
    throw new Error("invalid signature: 0x6c6f6f63");
  },
}));

vi.mock("@/../infra/database", () => ({
  default: {
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run({}),
  },
}));

import { ImportDeliverySpreadsheetUseCase } from "@/modules/import/usecases/import-delivery-spreadsheet/import-delivery-spreadsheet-usecase";
import { ImportQueue } from "@/modules/import/services/import-queue";

import { InMemoryImportRepository } from "@/modules/import/repositories/in-memory/in-memory-import-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";
import { InMemoryShipperRepository } from "@/modules/shipper/repositories/in-memory/in-memory-shipper-repository";
import { InMemoryDeliveryRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-repository";
import { InMemoryRouteRepository } from "@/modules/route/repositories/in-memory/in-memory-route-repository";
import { InMemoryDriverRepository } from "@/modules/driver/repositories/in-memory/in-memory-driver-repository";
import { InMemoryVehicleRepository } from "@/modules/vehicle/repositories/in-memory/in-memory-vehicle-repository";
import { InMemoryWebhookFanOutService } from "@/shared/integration/in-memory/in-memory-webhook-fan-out-service";
import { BUSINESS_COLUMN_DEFAULTS } from "@/shared/in-memory/column-defaults";

import type { User } from "@/modules/user/dtos/user-dto";
import type { Business } from "@/modules/business/dtos/business-dto";
import type { Shipper } from "@/modules/shipper/dtos/shipper-dto";
import type { NotificationService } from "@/shared/services/notification-service";

/**
 * An upload whose workbook cannot be loaded in the background is closed with
 * the reason on line 1 — never left IN_PROGRESS for the sweep, and never
 * thrown into a request that has already answered 202.
 */
const BUSINESS = "018f0000-0000-7000-8000-00000000000b";
const DISPATCHER = "018f0000-0000-7000-8000-0000000000a1";
const SHIPPER = "018f0000-0000-7000-8000-0000000000f1";

describe("an upload that cannot be read after it was accepted", () => {
  it("is closed with the reason, nothing created", async () => {
    const users = new InMemoryUserRepository();
    const businesses = new InMemoryBusinessRepository();
    const shippers = new InMemoryShipperRepository();
    const deliveries = new InMemoryDeliveryRepository();
    const imports = new InMemoryImportRepository();

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

    const useCase = new ImportDeliverySpreadsheetUseCase(
      users,
      businesses,
      shippers,
      deliveries,
      new InMemoryRouteRepository(deliveries.deliveries as never),
      new InMemoryDriverRepository(),
      new InMemoryVehicleRepository(),
      imports,
      {
        createActivityIfEnabled: async () => {},
      } as unknown as NotificationService,
      new InMemoryWebhookFanOutService().asService(),
    );

    const queue = new ImportQueue();

    const record = await useCase.start(
      {
        userId: DISPATCHER,
        businessId: BUSINESS,
        filename: "entregas.xlsx",
        content: Buffer.from("PK").toString("base64"),
        shipperId: SHIPPER,
      },
      queue,
    );

    expect(record.status).toBe("IN_PROGRESS");

    await queue.idle();

    const closed = await imports.findImportById(record.id, BUSINESS);

    expect(closed).toMatchObject({
      status: "COMPLETED",
      imported: 0,
      invalid: 1,
    });
    expect(closed!.report.rows).toEqual([
      expect.objectContaining({
        line: 1,
        outcome: "invalid",
        message: expect.stringContaining("Não foi possível ler a planilha"),
      }),
    ]);
    expect(deliveries.deliveries).toHaveLength(0);
  });
});
