import { beforeEach, describe, expect, it } from "vitest";

import { ReverseImportUseCase } from "@/modules/import/usecases/reverse-import/reverse-import-usecase";
import { InMemoryImportRepository } from "@/modules/import/repositories/in-memory/in-memory-import-repository";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";

import type { NotificationService } from "@/shared/services/notification-service";
import type { User } from "@/modules/user/dtos/user-dto";
import type { ImportReport } from "@/modules/import/dtos/import-dto";

/**
 * Taking back an upload, and the line it must not cross.
 *
 * The case this exists for is a dispatcher loading the wrong file at 6am and
 * needing two hundred deliveries gone. The case it must survive is the same
 * dispatcher realising at noon, when half of them are already on a truck.
 *
 * So the undo is partial rather than all-or-nothing: what nobody touched goes,
 * what somebody worked stays and is named. Refusing the whole undo over three
 * rows out of two hundred would leave the operator deleting the other hundred
 * and ninety-seven by hand — which is the exact situation this was built to
 * avoid, and the ones they miss go out on a truck.
 */
const BUSINESS = "018f0000-0000-7000-8000-00000000000b";
const OTHER_BUSINESS = "018f0000-0000-7000-8000-00000000000c";

const DISPATCHER = "018f0000-0000-7000-8000-0000000000a1";
const DRIVER_USER = "018f0000-0000-7000-8000-0000000000a2";

const IMPORT = "018f0000-0000-7000-8000-0000000000i1";

const emptyReport: ImportReport = {
  imported: 0,
  duplicated: 0,
  invalid: 0,
  unknownHeaders: [],
  rows: [],
  routes: [],
};

function makeContext() {
  const userRepository = new InMemoryUserRepository();
  const importRepository = new InMemoryImportRepository();

  userRepository.user.push(
    { id: DISPATCHER, role: "BUSINESS_ADMIN", businessId: BUSINESS } as User,
    {
      id: DRIVER_USER,
      role: "BUSINESS_USER",
      businessId: BUSINESS,
      driverId: "018f0000-0000-7000-8000-0000000000d1",
    } as User,
  );

  importRepository.imports.push({
    id: IMPORT,
    source: "SPREADSHEET",
    status: "COMPLETED",
    filename: "entregas-16-09.xlsx",
    imported: 0,
    duplicated: 0,
    invalid: 0,
    report: emptyReport,
    reversed_at: null,
    businessId: BUSINESS,
    performedById: DISPATCHER,
    created_at: new Date(),
  });

  return {
    importRepository,
    reverse: new ReverseImportUseCase(
      userRepository,
      importRepository,
      {
        createActivityIfEnabled: async () => undefined,
      } as unknown as NotificationService,
    ),
  };
}

type Context = ReturnType<typeof makeContext>;

let context: Context;

beforeEach(() => {
  context = makeContext();
});

function seedDelivery(
  id: string,
  overrides: Partial<{
    status: string;
    eventCount: number;
    occurrenceCount: number;
    businessId: string;
    importId: string | null;
  }> = {},
) {
  context.importRepository.deliveries.push({
    id,
    businessId: BUSINESS,
    importId: IMPORT,
    recipient_name: `Cliente ${id}`,
    status: "PENDING",
    ...overrides,
  });
}

function seedRoute(
  id: string,
  stopDeliveryIds: string[],
  overrides: Partial<{ status: string; businessId: string }> = {},
) {
  context.importRepository.routes.push({
    id,
    businessId: BUSINESS,
    importId: IMPORT,
    code: 1,
    status: "PLANNED",
    stopDeliveryIds,
    ...overrides,
  });
}

describe("undoing an upload nobody has touched", () => {
  it("removes everything it created", async () => {
    seedDelivery("d1");
    seedDelivery("d2");
    seedRoute("r1", ["d1", "d2"]);

    const result = await context.reverse.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      importId: IMPORT,
    });

    expect(result).toMatchObject({
      removedDeliveries: 2,
      removedRoutes: 1,
      keptDeliveries: [],
      keptRoutes: [],
    });

    expect(context.importRepository.deliveries).toEqual([]);
    expect(context.importRepository.routes).toEqual([]);
  });

  it("marks the upload as reversed, so the screen stops offering it", async () => {
    seedDelivery("d1");

    await context.reverse.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      importId: IMPORT,
    });

    expect(context.importRepository.imports[0].status).toBe("REVERSED");
    expect(context.importRepository.imports[0].reversed_at).not.toBeNull();
  });

  it("refuses a second undo instead of reporting that it removed nothing", async () => {
    // "Removed 0" reads like a failure. Saying it was already undone is what
    // tells the operator the first click worked.
    seedDelivery("d1");

    await context.reverse.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      importId: IMPORT,
    });

    await expect(
      context.reverse.execute({
        userId: DISPATCHER,
        businessId: BUSINESS,
        importId: IMPORT,
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "IMPORT_ALREADY_REVERSED",
    });
  });
});

describe("the line the undo must not cross", () => {
  it("keeps a delivery that already left, and names why", async () => {
    seedDelivery("untouched");
    seedDelivery("on-the-road", { status: "IN_TRANSIT" });

    const result = await context.reverse.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      importId: IMPORT,
    });

    expect(result.removedDeliveries).toBe(1);

    expect(result.keptDeliveries).toEqual([
      {
        id: "on-the-road",
        recipient_name: "Cliente on-the-road",
        reason: "Já saiu do status pendente.",
      },
    ]);
  });

  it("keeps a delivery the driver already reported on", async () => {
    // Still PENDING, but somebody registered an arrival on it. The status is
    // not the only evidence that a delivery was worked.
    seedDelivery("reported", { eventCount: 1 });

    const result = await context.reverse.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      importId: IMPORT,
    });

    expect(result.removedDeliveries).toBe(0);
    expect(result.keptDeliveries[0].reason).toContain("registros do motorista");
  });

  it("keeps a delivery with an occurrence on it", async () => {
    seedDelivery("with-occurrence", { occurrenceCount: 1 });

    const result = await context.reverse.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      importId: IMPORT,
    });

    expect(result.removedDeliveries).toBe(0);
    expect(result.keptDeliveries[0].reason).toContain("ocorrência");
  });

  it("keeps a route that would be left with holes in it", async () => {
    // Removing two of a route's three stops leaves a plan the dispatcher never
    // made. Keeping the whole route is the honest outcome — they can cancel it.
    seedDelivery("d1");
    seedDelivery("d2");
    seedDelivery("worked", { status: "DELIVERED" });

    seedRoute("r1", ["d1", "d2", "worked"]);

    const result = await context.reverse.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      importId: IMPORT,
    });

    expect(result.removedRoutes).toBe(0);
    expect(result.keptRoutes[0].reason).toContain("não puderam ser removidas");
  });

  it("keeps a route that already left, even with every stop removable", async () => {
    seedDelivery("d1");
    seedRoute("r1", ["d1"], { status: "IN_PROGRESS" });

    const result = await context.reverse.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      importId: IMPORT,
    });

    expect(result.removedRoutes).toBe(0);
    expect(result.keptRoutes[0].reason).toContain("liberada ou já saiu");
  });

  it("cuts what survived loose from the upload", async () => {
    // The import is being undone. A row that survived it did so on its own
    // merits, and leaving it pointing at a reversed upload would make it
    // reappear in any future undo of the same id.
    seedDelivery("worked", { status: "DELIVERED" });

    await context.reverse.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      importId: IMPORT,
    });

    expect(context.importRepository.deliveries[0].importId).toBeNull();
  });
});

describe("who may undo, and whose upload", () => {
  it("refuses another company's upload as if it did not exist", async () => {
    await expect(
      context.reverse.execute({
        userId: DISPATCHER,
        businessId: OTHER_BUSINESS,
        importId: IMPORT,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("refuses a driver", async () => {
    // Loading — and unloading — the company's day is the dispatcher's job.
    await expect(
      context.reverse.execute({
        userId: DRIVER_USER,
        businessId: BUSINESS,
        importId: IMPORT,
      }),
    ).rejects.toMatchObject({ code: "DRIVER_CANNOT_MANAGE_DELIVERIES" });
  });

  it("never touches another company's rows", async () => {
    seedDelivery("mine");
    seedDelivery("theirs", { businessId: OTHER_BUSINESS });

    await context.reverse.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      importId: IMPORT,
    });

    expect(
      context.importRepository.deliveries.map((delivery) => delivery.id),
    ).toEqual(["theirs"]);
  });
});
