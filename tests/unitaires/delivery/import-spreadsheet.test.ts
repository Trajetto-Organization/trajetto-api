import { beforeEach, describe, expect, it, vi } from "vitest";

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

import type { NotificationService } from "@/shared/services/notification-service";

import type { User } from "@/modules/user/dtos/user-dto";
import type { Business } from "@/modules/business/dtos/business-dto";

import type { Driver } from "@/modules/driver/dtos/driver-dto";
import type { Vehicle } from "@/modules/vehicle/dtos/vehicle-dto";

import type { Shipper } from "@/modules/shipper/dtos/shipper-dto";

import { InMemoryWebhookFanOutService } from "@/shared/integration/in-memory/in-memory-webhook-fan-out-service";
import { BUSINESS_COLUMN_DEFAULTS } from "@/shared/in-memory/column-defaults";

// Each row (and each route) commits with its webhook events; against
// in-memory repositories the transaction is a passthrough. What is announced
// is asserted in import-spreadsheet-webhooks.test.ts.
vi.mock("@/../infra/database", () => ({
  default: {
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run({}),
  },
}));

/**
 * A morning's work arriving as a spreadsheet.
 *
 * The parser is proven on its own, cell by cell. What is proven here is
 * everything the parser cannot see: which rows became deliveries, which were
 * refused as duplicates of yesterday's file, which routes were built out of
 * the route columns, and — the part that decides whether any of it can be
 * taken back — whether the rows the upload created actually carry its id.
 */
const BUSINESS = "018f0000-0000-7000-8000-00000000000b";
const OTHER_BUSINESS = "018f0000-0000-7000-8000-00000000000c";

const DISPATCHER = "018f0000-0000-7000-8000-0000000000a1";
const DRIVER_USER = "018f0000-0000-7000-8000-0000000000a2";

const SHIPPER = "018f0000-0000-7000-8000-0000000000f1";
const OTHER_SHIPPER = "018f0000-0000-7000-8000-0000000000f2";
const SECOND_SHIPPER = "018f0000-0000-7000-8000-0000000000f3";

const DRIVER = "018f0000-0000-7000-8000-0000000000d1";
const VEHICLE = "018f0000-0000-7000-8000-0000000000e1";

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

/** One line of the file, in the header's order. */
function line(
  recipient: string,
  extra: Partial<{
    invoiceKey: string;
    code: string;
    route: string;
    cnh: string;
    plate: string;
  }> = {},
) {
  return [
    recipient,
    "01001000",
    "São Paulo",
    "SP",
    "Praça da Sé",
    extra.invoiceKey ?? "",
    extra.code ?? "",
    extra.route ?? "",
    extra.cnh ?? "",
    extra.plate ?? "",
  ];
}

/**
 * The upload as the endpoint receives it: base64 of a CSV.
 *
 * CSV rather than a generated workbook because what is under test here is the
 * use case, not the reader — the reader has its own suite, and a semicolon
 * separator keeps the fields readable in the diff.
 */
function upload(rows: string[][]): string {
  const text = [HEADER, ...rows]
    .map((row) => row.map((cell) => `"${cell}"`).join(";"))
    .join("\n");

  return Buffer.from(text, "utf8").toString("base64");
}

function makeContext() {
  const userRepository = new InMemoryUserRepository();
  const businessRepository = new InMemoryBusinessRepository();

  const shipperRepository = new InMemoryShipperRepository();
  const deliveryRepository = new InMemoryDeliveryRepository();

  // The route fake mirrors onto the delivery fake's own rows, the way the two
  // tables share one database.
  const routeRepository = new InMemoryRouteRepository(
    deliveryRepository.deliveries as never,
  );

  const driverRepository = new InMemoryDriverRepository();
  const vehicleRepository = new InMemoryVehicleRepository();

  const importRepository = new InMemoryImportRepository();

  userRepository.user.push(
    { id: DISPATCHER, role: "BUSINESS_ADMIN", businessId: BUSINESS } as User,
    {
      id: DRIVER_USER,
      role: "BUSINESS_USER",
      businessId: BUSINESS,
      driverId: DRIVER,
    } as User,
  );

  businessRepository.business.push({
    ...BUSINESS_COLUMN_DEFAULTS,
    id: BUSINESS,
    is_active: true,
  } as Business);

  shipperRepository.shippers.push(
    { id: SHIPPER, name: "Embarcador", businessId: BUSINESS } as Shipper,
    {
      id: SECOND_SHIPPER,
      name: "Outro embarcador da casa",
      businessId: BUSINESS,
    } as Shipper,
    {
      id: OTHER_SHIPPER,
      name: "De outra",
      businessId: OTHER_BUSINESS,
    } as Shipper,
  );

  driverRepository.drivers.push({
    id: DRIVER,
    name: "João Motorista",
    cnh: CNH,
    status: "ACTIVE",
    businessId: BUSINESS,
  } as Driver);

  vehicleRepository.vehicles.push({
    id: VEHICLE,
    license_plate: PLATE,
    status: "ACTIVE",
    businessId: BUSINESS,
  } as Vehicle);

  const activityLog: string[] = [];

  const notifications = {
    createActivityIfEnabled: async (activity: { description: string }) => {
      activityLog.push(activity.description);
    },
  } as unknown as NotificationService;

  return {
    activityLog,

    deliveryRepository,
    routeRepository,
    importRepository,
    driverRepository,
    vehicleRepository,

    importSpreadsheet: new ImportDeliverySpreadsheetUseCase(
      userRepository,
      businessRepository,
      shipperRepository,
      deliveryRepository,
      routeRepository,
      driverRepository,
      vehicleRepository,
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

type Context = ReturnType<typeof makeContext>;

let context: Context;

beforeEach(() => {
  context = makeContext();
});

function run(rows: string[][], shipperId = SHIPPER) {
  return context.importSpreadsheet.execute({
    userId: DISPATCHER,
    businessId: BUSINESS,
    filename: "entregas-16-09.csv",
    content: upload(rows),
    shipperId,
  });
}

describe("a file that is simply right", () => {
  it("creates one delivery per line and reports each one", async () => {
    const record = await run([line("Padaria Central"), line("Mercado Novo")]);

    expect(record.imported).toBe(2);
    expect(record.duplicated).toBe(0);
    expect(record.invalid).toBe(0);

    expect(context.deliveryRepository.deliveries).toHaveLength(2);

    expect(record.report.rows.map((row) => [row.line, row.outcome])).toEqual([
      [2, "imported"],
      [3, "imported"],
    ]);
  });

  it("closes the upload, so the listing stops calling it open", async () => {
    const record = await run([line("Padaria Central")]);

    expect(record.status).toBe("COMPLETED");
    expect(context.importRepository.imports[0].status).toBe("COMPLETED");
  });

  it("writes the report to the record, not only to the response", async () => {
    // "Qual das duzentas falhou?" is asked hours later by somebody who did not
    // do the upload and cannot re-run it to find out.
    await run([line("Padaria Central"), line("")]);

    const stored = context.importRepository.imports[0];

    expect(stored.report.rows).toHaveLength(2);
    expect(stored.invalid).toBe(1);
  });

  it("names the file in the activity feed", async () => {
    await run([line("Padaria Central")]);

    expect(context.activityLog[0]).toContain("entregas-16-09.csv");
  });
});

describe("the id every created row has to carry", () => {
  it("stamps the deliveries at creation, not afterwards", async () => {
    // Stamping at the end leaves a crash window in which the rows exist and
    // belong to no upload — and an upload nobody can undo is the exact
    // situation the undo button exists for.
    const record = await run([line("Padaria Central")]);

    expect(
      context.deliveryRepository.deliveries.map(
        (delivery) => (delivery as { importId?: string | null }).importId,
      ),
    ).toEqual([record.id]);
  });

  it("stamps the routes it creates, or the undo would never find them", async () => {
    const record = await run([
      line("Padaria Central", { route: "Zona Sul", cnh: CNH, plate: PLATE }),
      line("Mercado Novo", { route: "Zona Sul", cnh: CNH, plate: PLATE }),
    ]);

    expect(context.routeRepository.routes).toHaveLength(1);
    expect(context.routeRepository.routes[0].importId).toBe(record.id);
  });

  it("opens the record before the first row exists", async () => {
    // Observable through the fake: the delivery repository can only report an
    // importId that already existed when the row was written.
    const record = await run([line("Padaria Central")]);

    const [delivery] = context.deliveryRepository.deliveries;

    expect((delivery as { importId?: string | null }).importId).toBe(record.id);
    expect(record.id).toBeTruthy();
  });
});

describe("re-uploading yesterday's file", () => {
  const KEY = "3".repeat(44);

  it("refuses the same invoice as duplicated, not as an error", async () => {
    // The operator who is not sure whether the upload went through will click
    // again, and that has to be safe and has to READ as safe.
    await run([line("Padaria Central", { invoiceKey: KEY })]);

    const again = await run([line("Padaria Central", { invoiceKey: KEY })]);

    expect(again.imported).toBe(0);
    expect(again.duplicated).toBe(1);
    expect(again.invalid).toBe(0);

    expect(again.report.rows[0].message).toContain("já havia sido importada");
    expect(context.deliveryRepository.deliveries).toHaveLength(1);
  });

  it("falls back to the order number for a company that issues no invoice", async () => {
    await run([line("Padaria Central", { code: "PED-4471" })]);

    const again = await run([line("Padaria Central", { code: "PED-4471" })]);

    expect(again.duplicated).toBe(1);
    expect(again.report.rows[0].message).toContain("este embarcador");
  });

  it("lets the same order number through for a different shipper", async () => {
    // Two customers' order numbers collide constantly — "PED-4471" from one
    // shipper and from another are two different loads. Treating them as the
    // same delivery would silently drop one of them.
    await run([line("Padaria Central", { code: "PED-4471" })]);

    const again = await run(
      [line("Padaria Central", { code: "PED-4471" })],
      SECOND_SHIPPER,
    );

    expect(again.imported).toBe(1);
    expect(again.duplicated).toBe(0);

    expect(context.deliveryRepository.deliveries).toHaveLength(2);
  });

  it("imports a row twice when it carries neither key nor order", async () => {
    // Nothing to be the same as. Importing it twice is the operator's call and
    // the report shows two lines.
    await run([line("Padaria Central")]);

    const again = await run([line("Padaria Central")]);

    expect(again.imported).toBe(1);
    expect(context.deliveryRepository.deliveries).toHaveLength(2);
  });
});

describe("the route columns", () => {
  it("builds one route per group, in sheet order", async () => {
    const record = await run([
      line("Primeira", { route: "Zona Sul", cnh: CNH }),
      line("Segunda", { route: "Zona Sul", cnh: CNH }),
      line("Terceira", { route: "Zona Norte", cnh: CNH }),
    ]);

    expect(record.report.routes).toHaveLength(2);

    const [sul, norte] = record.report.routes;

    expect(sul).toMatchObject({ name: "Zona Sul", stops: 2 });
    expect(norte).toMatchObject({ name: "Zona Norte", stops: 1 });
  });

  it("imports the deliveries anyway when the CNH is unknown", async () => {
    // A typo in one cell must not cost the operator two hundred deliveries.
    // They fix the CNH and build the route in the panel.
    const record = await run([
      line("Padaria Central", { route: "Zona Sul", cnh: "99999999999" }),
    ]);

    expect(record.imported).toBe(1);
    expect(record.report.routes).toEqual([]);

    expect(record.report.rows[0].message).toContain("rota não foi criada");
    expect(record.report.rows[0].message).toContain("99999999999");
  });

  it("creates the route without the vehicle when the plate is unknown", async () => {
    const record = await run([
      line("Padaria Central", {
        route: "Zona Sul",
        cnh: CNH,
        plate: "ZZZ9Z99",
      }),
    ]);

    expect(record.report.routes).toHaveLength(1);
    expect(context.routeRepository.routes[0].vehicleId).toBeNull();

    expect(record.report.rows[0].message).toContain("sem veículo");
  });

  it("refuses a driver from another company as if the CNH did not exist", async () => {
    context.driverRepository.drivers.push({
      id: "018f0000-0000-7000-8000-0000000000d9",
      name: "De outra transportadora",
      cnh: "55555555555",
      status: "ACTIVE",
      businessId: OTHER_BUSINESS,
    } as Driver);

    const record = await run([
      line("Padaria Central", { route: "Zona Sul", cnh: "55555555555" }),
    ]);

    expect(record.report.routes).toEqual([]);
    expect(record.report.rows[0].message).toContain("não encontrado");
  });

  /**
   * CNH and plate are unique PER COMPANY (decision 8.1), so another carrier
   * may hold the same ones. A global lookup could answer with that carrier's
   * row first and report our own driver or truck as missing.
   */
  it("finds its own driver when another carrier registered the same CNH first", async () => {
    context.driverRepository.drivers.unshift({
      id: "018f0000-0000-7000-8000-0000000000d8",
      name: "Homônimo de outra transportadora",
      cnh: CNH,
      status: "ACTIVE",
      businessId: OTHER_BUSINESS,
    } as Driver);

    const record = await run([
      line("Padaria Central", { route: "Zona Sul", cnh: CNH }),
    ]);

    expect(record.report.routes).toHaveLength(1);
    expect(context.routeRepository.routes[0].driverId).toBe(DRIVER);
  });

  it("finds its own truck when another carrier registered the same plate first", async () => {
    context.vehicleRepository.vehicles.unshift({
      id: "018f0000-0000-7000-8000-0000000000e8",
      license_plate: PLATE,
      status: "ACTIVE",
      businessId: OTHER_BUSINESS,
    } as Vehicle);

    const record = await run([
      line("Padaria Central", { route: "Zona Sul", cnh: CNH, plate: PLATE }),
    ]);

    expect(record.report.routes).toHaveLength(1);
    expect(context.routeRepository.routes[0].vehicleId).toBe(VEHICLE);
    expect(record.report.rows[0].message ?? "").not.toContain("sem veículo");
  });
});

describe("who may upload, and whose cargo", () => {
  it("refuses a driver", async () => {
    await expect(
      context.importSpreadsheet.execute({
        userId: DRIVER_USER,
        businessId: BUSINESS,
        filename: "entregas.csv",
        content: upload([line("Padaria Central")]),
        shipperId: SHIPPER,
      }),
    ).rejects.toMatchObject({ code: "DRIVER_CANNOT_MANAGE_DELIVERIES" });
  });

  it("refuses another company's shipper as if it did not exist", async () => {
    await expect(run([line("Padaria Central")], OTHER_SHIPPER)).rejects.toMatchObject(
      { statusCode: 404, code: "SHIPPER_NOT_FOUND" },
    );
  });

  it("says it was the file when the file cannot be read", async () => {
    await expect(
      context.importSpreadsheet.execute({
        userId: DISPATCHER,
        businessId: BUSINESS,
        filename: "entregas.xlsx",
        content: Buffer.from("isto não é uma planilha").toString("base64"),
        shipperId: SHIPPER,
      }),
    ).rejects.toMatchObject({ code: "SPREADSHEET_UNREADABLE" });
  });
});

describe("undoing an upload that is still running", () => {
  it("is refused, because the two would race over the same rows", async () => {
    const record = await context.importRepository.createImport({
      source: "SPREADSHEET",
      filename: "em-andamento.csv",
      businessId: BUSINESS,
      performedById: DISPATCHER,
    });

    await expect(
      context.reverse.execute({
        userId: DISPATCHER,
        businessId: BUSINESS,
        importId: record.id,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "IMPORT_IN_PROGRESS" });
  });

  it("is allowed the moment it closes", async () => {
    const record = await run([line("Padaria Central")]);

    await expect(
      context.reverse.execute({
        userId: DISPATCHER,
        businessId: BUSINESS,
        importId: record.id,
      }),
    ).resolves.toBeDefined();
  });
});
