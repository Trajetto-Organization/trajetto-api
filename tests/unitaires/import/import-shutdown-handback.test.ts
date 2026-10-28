import { describe, expect, it, vi } from "vitest";

// Each row commits with its webhook events; against in-memory repositories
// the transaction is a passthrough.
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
 * A deploy while spreadsheet uploads are on this replica.
 *
 * Before: the upload being processed was cut mid-file, and the ones waiting
 * their turn — already answered 202 — simply vanished. Every record stayed
 * IN_PROGRESS until the abandoned-import sweep found its heartbeat stale,
 * 15 to 20 minutes later, and then told the operator to undo an upload that
 * in the waiting case had never created anything.
 *
 * Now the record says what happened the moment the replica stops: a waiting
 * upload was not started (send it again), and the running one stopped at a
 * row boundary with the line it reached.
 */
const BUSINESS = "018f0000-0000-7000-8000-00000000000b";
const DISPATCHER = "018f0000-0000-7000-8000-0000000000a1";
const SHIPPER = "018f0000-0000-7000-8000-0000000000f1";

const HEADER = ["Destinatário", "CEP", "Cidade", "UF", "Logradouro", "Pedido"];

function upload(count: number): string {
  const rows = Array.from({ length: count }, (_, index) => [
    `Destinatário ${index + 1}`,
    "01001000",
    "São Paulo",
    "SP",
    "Praça da Sé",
    `PED-${index + 1}`,
  ]);

  const text = [HEADER, ...rows]
    .map((row) => row.map((cell) => `"${cell}"`).join(";"))
    .join("\n");

  return Buffer.from(text, "utf8").toString("base64");
}

function makeContext(rowDelayMs = 0) {
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

  // A row that takes a moment, like a real commit, so a stop lands mid-file.
  if (rowDelayMs > 0) {
    const create = deliveries.createDelivery.bind(deliveries);

    deliveries.createDelivery = (async (...args: Parameters<typeof create>) => {
      await new Promise((resolve) => setTimeout(resolve, rowDelayMs));
      return create(...args);
    }) as typeof create;
  }

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

  const start = (rows: number, queue: ImportQueue) =>
    useCase.start(
      {
        userId: DISPATCHER,
        businessId: BUSINESS,
        filename: "entregas.csv",
        content: upload(rows),
        shipperId: SHIPPER,
      },
      queue,
    );

  // A big workbook: the file is still being read until `until` settles.
  const holdReading = (until: Promise<void>) => {
    const reader = useCase as unknown as {
      readMatrix: (filename: string, content: string) => Promise<unknown[][]>;
    };
    const read = reader.readMatrix.bind(useCase);

    vi.spyOn(reader, "readMatrix").mockImplementation(
      async (filename, content) => {
        await until;

        return read(filename, content);
      },
    );
  };

  return { start, holdReading, imports, deliveries };
}

function gate() {
  let open: () => void = () => {};
  const opened = new Promise<void>((resolve) => (open = resolve));

  return { opened, open };
}

describe("spreadsheet uploads on a replica that shuts down", () => {
  it("closes a waiting upload at once: not started, nothing created, send it again", async () => {
    const context = makeContext(5);
    const queue = new ImportQueue(1, 3);

    const running = await context.start(40, queue);
    const waiting = await context.start(3, queue);

    // The grace is long: the running one finishes, the waiting one never
    // starts.
    await queue.drain({ graceMs: 60_000 });

    const closedWaiting = await context.imports.findImportById(
      waiting.id,
      BUSINESS,
    );

    expect(closedWaiting).toMatchObject({
      status: "COMPLETED",
      imported: 0,
      invalid: 1,
    });
    expect(closedWaiting!.report.rows).toEqual([
      expect.objectContaining({
        line: 1,
        outcome: "invalid",
        message: expect.stringContaining("Importação não iniciada"),
      }),
    ]);
    expect(closedWaiting!.report.rows[0].message).toContain(
      "Envie o arquivo de novo",
    );

    expect(
      await context.imports.findImportById(running.id, BUSINESS),
    ).toMatchObject({ status: "COMPLETED", imported: 40 });
    expect(context.deliveries.deliveries).toHaveLength(40);
  });

  it("stops the running upload between two rows and closes it with the line it reached", async () => {
    const context = makeContext(10);
    const queue = new ImportQueue(1, 3);

    const record = await context.start(200, queue);

    await queue.drain({ graceMs: 60, stopGraceMs: 2_000 });

    const closed = await context.imports.findImportById(record.id, BUSINESS);
    const created = context.deliveries.deliveries.length;

    expect(created).toBeGreaterThan(0);
    expect(created).toBeLessThan(200);

    expect(closed).toMatchObject({ status: "COMPLETED", imported: created });

    const stop = closed!.report.rows.find((row) =>
      row.message?.includes("reinício do servidor"),
    );

    // The header is line 1, so the first row not processed is line
    // created + 2; every line before it has its own outcome.
    expect(stop).toMatchObject({ line: created + 2, outcome: "invalid" });
    expect(stop!.message).toContain("Estorne esta importação");
    expect(
      closed!.report.rows.filter((row) => row.outcome === "imported"),
    ).toHaveLength(created);
  });

  // A big workbook still being read when the stop grace ran out was handed
  // back with "the deliveries created so far … estorne" over zero deliveries.
  it("hands back an upload still reading its file as not started: nothing created, send it again", async () => {
    const context = makeContext();
    const queue = new ImportQueue(1, 3);
    const reading = gate();

    context.holdReading(reading.opened);

    const record = await context.start(3, queue);

    await queue.drain({ graceMs: 10, stopGraceMs: 10 });

    const closed = await context.imports.findImportById(record.id, BUSINESS);

    expect(closed).toMatchObject({
      status: "COMPLETED",
      imported: 0,
      invalid: 1,
    });
    expect(closed!.report.rows).toHaveLength(1);
    expect(closed!.report.rows[0].message).toContain(
      "nenhuma entrega foi criada",
    );
    expect(closed!.report.rows[0].message).not.toContain("Estorne");

    // The file finishes reading after the hand-back: the stop signal ends it
    // before its first row, so "nothing created" stays true.
    reading.open();
    await queue.idle();

    expect(context.deliveries.deliveries).toHaveLength(0);
    expect(
      (await context.imports.findImportById(record.id, BUSINESS))!.report,
    ).toEqual(closed!.report);
  });

  it("closes an upload that finished reading only after it was asked to stop: nothing created", async () => {
    const context = makeContext();
    const queue = new ImportQueue(1, 3);
    const reading = gate();

    context.holdReading(reading.opened);

    const record = await context.start(3, queue);
    const drained = queue.drain({ graceMs: 10, stopGraceMs: 2_000 });

    // Past the grace: the stop signal is already up when the rows begin.
    await new Promise((resolve) => setTimeout(resolve, 40));
    reading.open();
    await drained;

    const closed = await context.imports.findImportById(record.id, BUSINESS);

    expect(context.deliveries.deliveries).toHaveLength(0);
    expect(closed).toMatchObject({ status: "COMPLETED", imported: 0 });

    // Line 2: the first row, which it stopped before.
    expect(closed!.report.rows).toEqual([
      expect.objectContaining({ line: 2, outcome: "invalid" }),
    ]);
    expect(closed!.report.rows[0].message).toContain(
      "nenhuma entrega foi criada",
    );
    expect(closed!.report.rows[0].message).not.toContain("Estorne");
  });

  it("refuses an upload arriving while the replica drains, before opening a record", async () => {
    const context = makeContext();
    const queue = new ImportQueue(1, 3);

    const drained = queue.drain({ graceMs: 0 });

    await expect(context.start(1, queue)).rejects.toMatchObject({
      statusCode: 429,
      code: "IMPORT_BUSY",
    });

    await drained;

    expect(context.imports.imports).toHaveLength(0);
  });
});
