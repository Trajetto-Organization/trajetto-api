import { beforeEach, describe, expect, it, vi } from "vitest";

const { log } = vi.hoisted(() => ({ log: [] as string[] }));

type RouteHint = { type: string; routeId: string; routeCode?: number };

vi.mock("@/websocket", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/websocket")>()),
  sendRouteEventToBusiness: (businessId: string, event: RouteHint) => {
    const { type, routeId, routeCode } = event;

    log.push(`${type}:${routeId}:${routeCode}@${businessId}`);
  },
}));

// Each route of the sheet commits in its own transaction; against the
// in-memory repositories it is a passthrough that says when it committed.
vi.mock("@/../infra/database", () => ({
  default: {
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => {
      const result = await run({});

      log.push("commit");

      return result;
    },
  },
}));

import { ImportDeliverySpreadsheetUseCase } from "@/modules/import/usecases/import-delivery-spreadsheet/import-delivery-spreadsheet-usecase";
import { ReverseImportUseCase } from "@/modules/import/usecases/reverse-import/reverse-import-usecase";
import { ImportRepository } from "@/modules/import/repositories/import-repository";
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
import { emptyReversalProgress } from "@/modules/import/services/import-reversal";

import type { NotificationService } from "@/shared/services/notification-service";
import type { User } from "@/modules/user/dtos/user-dto";
import type { Business } from "@/modules/business/dtos/business-dto";
import type { Driver } from "@/modules/driver/dtos/driver-dto";
import type { Shipper } from "@/modules/shipper/dtos/shipper-dto";
import type { ImportReport } from "@/modules/import/dtos/import-dto";

/**
 * The routes the spreadsheet import builds and the PLANNED ones its undo
 * deletes, told to the operations room (audit of 25/11/2026).
 *
 * The Rotas screen's create says `route.created` after its commit; the
 * import built its routes on its own and said nothing, so a colleague's
 * boards and route pickers ("Adicionar à rota", "Reentregar") never listed
 * them until a reload. Its undo deleted PLANNED routes in silence too: the
 * other tabs kept offering them, and choosing one answered 404. Each route
 * is now told once, after the commit that wrote it — never about a write
 * that rolled back, and never about a route that was kept.
 */

const BUSINESS = "018f0000-0000-7000-8000-00000000000b";
const DISPATCHER = "018f0000-0000-7000-8000-0000000000a1";
const SHIPPER = "018f0000-0000-7000-8000-0000000000f1";
const DRIVER = "018f0000-0000-7000-8000-0000000000d1";
const CNH = "01234567890";

const HEADER = [
  "Destinatário",
  "CEP",
  "Cidade",
  "UF",
  "Logradouro",
  "Rota",
  "CNH do motorista",
];

function line(recipient: string, route: string, cnh = CNH): string[] {
  return [recipient, "01001000", "São Paulo", "SP", "Praça da Sé", route, cnh];
}

/** A hint as the websocket stub logs it. */
function hint(type: string, route: { id: string; code: number }): string {
  return `${type}:${route.id}:${route.code}@${BUSINESS}`;
}

function upload(rows: string[][]): string {
  const text = [HEADER, ...rows]
    .map((row) => row.map((cell) => `"${cell}"`).join(";"))
    .join("\n");

  return Buffer.from(text, "utf8").toString("base64");
}

const notifications = {
  createActivityIfEnabled: async () => undefined,
} as unknown as NotificationService;

function importContext() {
  const users = new InMemoryUserRepository();
  const businesses = new InMemoryBusinessRepository();
  const shippers = new InMemoryShipperRepository();
  const deliveries = new InMemoryDeliveryRepository();
  const routes = new InMemoryRouteRepository(deliveries.deliveries as never);
  const drivers = new InMemoryDriverRepository();

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

  const useCase = new ImportDeliverySpreadsheetUseCase(
    users,
    businesses,
    shippers,
    deliveries,
    routes,
    drivers,
    new InMemoryVehicleRepository(),
    new InMemoryImportRepository(),
    notifications,
    new InMemoryWebhookFanOutService().asService(),
  );

  return {
    routes,
    run: (rows: string[][]) =>
      useCase.execute({
        userId: DISPATCHER,
        businessId: BUSINESS,
        filename: "entregas.csv",
        content: upload(rows),
        shipperId: SHIPPER,
      }),
  };
}

beforeEach(() => {
  log.length = 0;
});

describe("the spreadsheet import announces the routes it builds", () => {
  it("says route.created once per route, each after its own commit", async () => {
    const { run, routes } = importContext();

    await run([
      line("Primeira", "Zona Sul"),
      line("Segunda", "Zona Sul"),
      line("Terceira", "Zona Norte"),
    ]);

    const built = routes.routes;

    expect(built).toHaveLength(2);

    const created = log.filter((entry) => entry.startsWith("route.created"));

    const expected = built.map((route) => hint("route.created", route));

    expect(created).toEqual(expected);

    for (const entry of created) {
      expect(log[log.indexOf(entry) - 1]).toBe("commit");
    }
  });

  it("says nothing for a group whose route was not built", async () => {
    const { run } = importContext();

    await run([line("Primeira", "Zona Sul", "99999999999")]);

    expect(log.filter((entry) => entry.startsWith("route."))).toEqual([]);
  });
});

const IMPORT = "018f0000-0000-7000-8000-0000000000c1";

const emptyReport: ImportReport = {
  imported: 0,
  duplicated: 0,
  invalid: 0,
  unknownHeaders: [],
  rows: [],
  routes: [],
};

function reversalContext() {
  const users = new InMemoryUserRepository();
  const imports = new InMemoryImportRepository();

  users.user.push({
    id: DISPATCHER,
    role: "BUSINESS_ADMIN",
    businessId: BUSINESS,
  } as User);
  imports.imports.push({
    id: IMPORT,
    source: "SPREADSHEET",
    status: "COMPLETED",
    filename: "entregas.xlsx",
    imported: 0,
    duplicated: 0,
    invalid: 0,
    report: emptyReport,
    reversed_at: null,
    businessId: BUSINESS,
    performedById: DISPATCHER,
    created_at: new Date(),
  });

  const seedDelivery = (id: string, status = "PENDING") =>
    imports.deliveries.push({
      id,
      businessId: BUSINESS,
      importId: IMPORT,
      recipient_name: `Cliente ${id}`,
      status,
    });
  const seedRoute = (
    id: string,
    code: number,
    stopDeliveryIds: string[],
    status = "PLANNED",
  ) =>
    imports.routes.push({
      id,
      businessId: BUSINESS,
      importId: IMPORT,
      code,
      status,
      stopDeliveryIds,
    } as never);

  const useCase = new ReverseImportUseCase(
    users,
    imports,
    notifications,
    new InMemoryWebhookFanOutService().asService(),
  );
  const request = {
    userId: DISPATCHER,
    businessId: BUSINESS,
    importId: IMPORT,
  };

  return { seedDelivery, seedRoute, reverse: () => useCase.execute(request) };
}

describe("the undo announces the routes it deleted", () => {
  it("says route.removed for each deleted route, and none for a kept one", async () => {
    const { seedDelivery, seedRoute, reverse } = reversalContext();

    seedDelivery("d1");
    seedDelivery("d2");
    seedDelivery("d3", "IN_TRANSIT");
    seedRoute("r1", 7, ["d1"]);
    seedRoute("r2", 8, ["d2"]);
    // A stop already worked keeps its route.
    seedRoute("r3", 9, ["d3"]);

    const result = await reverse();

    expect(result.removedRoutes).toBe(2);
    expect(log.filter((entry) => entry.startsWith("route."))).toEqual([
      `route.removed:r1:7@${BUSINESS}`,
      `route.removed:r2:8@${BUSINESS}`,
    ]);
  });

  it("says nothing when no route went", async () => {
    const { seedDelivery, reverse } = reversalContext();

    seedDelivery("d1");

    await reverse();

    expect(log.filter((entry) => entry.startsWith("route."))).toEqual([]);
  });
});

/**
 * The real repository's route step, against a stub client: the routes it
 * tells are the rows it locked still PLANNED (a route released since the
 * unlocked read is neither deleted nor told), and the hook runs only after
 * the step's transaction returned — committed.
 */
describe("the repository's route step", () => {
  function stubClient(lockedRows: Array<{ id: string; code: number }>) {
    const deleted: string[][] = [];
    const tx = {
      import: { updateMany: async () => ({ count: 1 }) },
      route: {
        findMany: async (args: { select: Record<string, boolean> }) =>
          "status" in args.select
            ? [
                { id: "r1", code: 7, status: "PLANNED" },
                { id: "r2", code: 8, status: "PLANNED" },
              ]
            : [],
        deleteMany: async (args: { where: { id: { in: string[] } } }) => {
          deleted.push(args.where.id.in);

          return { count: args.where.id.in.length };
        },
        updateMany: async () => ({ count: 0 }),
      },
      $queryRaw: async () => lockedRows,
    };
    let transactions = 0;
    const client = {
      import: { updateMany: async () => ({ count: 1 }) },
      async $transaction(work: (tx: unknown) => Promise<unknown>) {
        transactions += 1;

        // The deliveries' step is beside the point: it stops the run.
        if (transactions > 1) throw new Error("stop after the routes");

        const result = await work(tx);

        log.push("commit");

        return result;
      },
    };

    return { client, deleted };
  }

  function reverseRoutesOf(
    client: unknown,
    onRoutesRemoved: (routes: Array<{ id: string; code: number }>) => void,
  ) {
    const repository = new ImportRepository(client as never);
    const progress = emptyReversalProgress(new Date());

    return repository.runReversal(IMPORT, BUSINESS, new Date(), progress, {
      onRoutesRemoved,
    });
  }

  it("tells the locked rows after the commit, and deletes only those", async () => {
    // r2 was released between the read and the lock.
    const { client, deleted } = stubClient([{ id: "r1", code: 7 }]);
    const told: Array<{ id: string; code: number }> = [];
    const run = reverseRoutesOf(client, (routes) => {
      log.push("told");
      told.push(...routes);
    });

    await expect(run).rejects.toThrow("stop after the routes");

    expect(told).toEqual([{ id: "r1", code: 7 }]);
    expect(deleted).toEqual([["r1"]]);
    expect(log).toEqual(["commit", "told"]);
  });

  it("tells nothing when every route moved before the lock", async () => {
    const { client, deleted } = stubClient([]);
    const onRoutesRemoved = vi.fn();

    await expect(reverseRoutesOf(client, onRoutesRemoved)).rejects.toThrow();

    expect(onRoutesRemoved).not.toHaveBeenCalled();
    expect(deleted).toEqual([]);
  });
});
