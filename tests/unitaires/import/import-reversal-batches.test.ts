import { beforeEach, describe, expect, it } from "vitest";

import { ReverseImportUseCase } from "@/modules/import/usecases/reverse-import/reverse-import-usecase";
import { GetImportUseCase } from "@/modules/import/usecases/get-import/get-import-usecase";
import { InMemoryImportRepository } from "@/modules/import/repositories/in-memory/in-memory-import-repository";
import { ImportQueue } from "@/modules/import/services/import-queue";
import {
  KEEP_REASON,
  REVERSAL_INLINE_LIMIT,
  REVERSAL_STALE_AFTER_MS,
  reversalView,
} from "@/modules/import/services/import-reversal";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import type { NotificationService } from "@/shared/services/notification-service";
import { InMemoryWebhookFanOutService } from "@/shared/integration/in-memory/in-memory-webhook-fan-out-service";
import type { User } from "@/modules/user/dtos/user-dto";
import type { ImportReport } from "@/modules/import/dtos/import-dto";

/**
 * Undoing an upload in batches, and picking it up where it stopped.
 *
 * The undo was one interactive transaction with Prisma's 15 s timeout: a
 * 2,000-delivery upload took 29 s to undo and failed every time, so a
 * 20,000-row upload could never be taken back. It now commits a batch at a
 * time. What must not change is WHAT it removes and keeps; what must hold
 * on top is that a crash halfway leaves a record that says how far it got,
 * still COMPLETED, and that asking again finishes the job without removing
 * or announcing anything twice.
 */
const BUSINESS = "018f0000-0000-7000-8000-00000000000b";
const DISPATCHER = "018f0000-0000-7000-8000-0000000000a1";
const IMPORT = "018f0000-0000-7000-8000-0000000000e1";

const emptyReport: ImportReport = {
  imported: 0,
  duplicated: 0,
  invalid: 0,
  unknownHeaders: [],
  rows: [],
  routes: [],
};

let imports: InMemoryImportRepository;
let webhooks: InMemoryWebhookFanOutService;
let reverse: ReverseImportUseCase;
let activities: string[];

const request = { userId: DISPATCHER, businessId: BUSINESS, importId: IMPORT };

beforeEach(() => {
  const users = new InMemoryUserRepository();

  users.user.push({
    id: DISPATCHER,
    role: "BUSINESS_ADMIN",
    businessId: BUSINESS,
  } as User);

  imports = new InMemoryImportRepository();
  webhooks = new InMemoryWebhookFanOutService();
  activities = [];

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

  reverse = new ReverseImportUseCase(
    users,
    imports,
    {
      createActivityIfEnabled: async (activity: { status: string }) => {
        activities.push(activity.status);
      },
    } as unknown as NotificationService,
    webhooks.asService(),
  );
});

/** d001, d002…: ids that sort in the order they were seeded. */
const id = (n: number) => `d${String(n).padStart(4, "0")}`;

function seedDeliveries(
  count: number,
  overrides: (n: number) => Partial<{
    status: string;
    eventCount: number;
    occurrenceCount: number;
  }> = () => ({}),
) {
  for (let n = 1; n <= count; n += 1) {
    imports.deliveries.push({
      id: id(n),
      businessId: BUSINESS,
      importId: IMPORT,
      recipient_name: `Cliente ${n}`,
      status: "PENDING",
      ...overrides(n),
    });
  }
}

const record = () => imports.imports[0];

const cancelled = () =>
  webhooks
    .forTopic("delivery.cancelled")
    .map((event) => (event.payload as { delivery_id: string }).delivery_id)
    .sort();

async function claim() {
  const claimed = await imports.claimReversal(
    IMPORT,
    BUSINESS,
    new Date(Date.now() - REVERSAL_STALE_AFTER_MS),
  );

  if (claimed.outcome !== "claimed") throw new Error(claimed.outcome);

  return claimed;
}

describe("the undo in batches", () => {
  it("decides exactly what one pass decided: routes against every delivery, not the batch's", async () => {
    // Ten deliveries in batches of three. The route holds d0002 and d0009;
    // d0009 was worked, so the route stays whole — and d0002, removable on
    // its own and in an earlier batch than d0009, stays with it.
    seedDeliveries(10, (n) => (n === 9 ? { status: "DELIVERED" } : {}));

    imports.routes.push(
      {
        id: "r1",
        businessId: BUSINESS,
        importId: IMPORT,
        code: 1,
        status: "PLANNED",
        stopDeliveryIds: [id(2), id(9)],
      },
      {
        id: "r2",
        businessId: BUSINESS,
        importId: IMPORT,
        code: 2,
        status: "PLANNED",
        stopDeliveryIds: [id(3), id(4)],
      },
    );

    const { lease, progress } = await claim();

    const result = await imports.runReversal(
      IMPORT,
      BUSINESS,
      lease,
      progress,
      {
        batchSize: 3,
      },
    );

    expect(result.removedRoutes).toBe(1);
    expect(result.keptRoutes).toEqual([
      { id: "r1", code: 1, reason: KEEP_REASON.routeWithKeptStops },
    ]);

    expect(result.removedDeliveries).toBe(8);
    expect(
      result.keptDeliveries.map((entry) => [entry.id, entry.reason]),
    ).toEqual([
      [id(2), KEEP_REASON.deliveryOnKeptRoute],
      [id(9), KEEP_REASON.deliveryLeftPending],
    ]);

    expect(imports.deliveries.map((row) => row.id).sort()).toEqual([
      id(2),
      id(9),
    ]);

    // What survived no longer claims the upload.
    expect(imports.deliveries.every((row) => row.importId === null)).toBe(true);
    expect(imports.routes.map((route) => [route.id, route.importId])).toEqual([
      ["r1", null],
    ]);

    expect(record().status).toBe("REVERSED");
    expect(record().reversal_started_at).toBeNull();
  });

  it("flips the upload to REVERSED only with the last batch", async () => {
    seedDeliveries(5);

    const { lease, progress } = await claim();
    const statuses: string[] = [];

    await imports.runReversal(IMPORT, BUSINESS, lease, progress, {
      batchSize: 2,
      onRemoved: async () => {
        statuses.push(record().status);
      },
    });

    // Three batches; while each one ran, the upload still said COMPLETED.
    expect(statuses).toEqual(["COMPLETED", "COMPLETED", "COMPLETED"]);
    expect(record().status).toBe("REVERSED");
  });
});

describe("an undo that stopped halfway", () => {
  it("keeps what it did on the record, reads INTERRUPTED, and is resumed by asking again", async () => {
    seedDeliveries(6);

    const { lease, progress } = await claim();
    let batches = 0;

    await expect(
      imports.runReversal(IMPORT, BUSINESS, lease, progress, {
        batchSize: 2,
        onRemoved: async () => {
          batches += 1;
          if (batches === 2) throw new Error("connection reset");
        },
      }),
    ).rejects.toThrow("connection reset");

    // The first batch committed, the second rolled back.
    expect(imports.deliveries.map((row) => row.id)).toEqual([
      id(3),
      id(4),
      id(5),
      id(6),
    ]);

    // Still COMPLETED (the panel keeps offering the undo), the lease gone so
    // the retry does not wait, and the progress counted.
    expect(record().status).toBe("COMPLETED");
    expect(record().reversal_started_at).toBeNull();
    expect(reversalView(record())).toMatchObject({
      state: "INTERRUPTED",
      removedDeliveries: 2,
    });

    // The retry finishes the job and adds to what was there.
    const result = await reverse.execute(request);

    expect(result.removedDeliveries).toBe(6);
    expect(imports.deliveries).toEqual([]);
    expect(record().status).toBe("REVERSED");
    expect(reversalView(record())?.state).toBe("DONE");

    // Every delivery announced once: the rolled-back batch's announcement
    // never happened, the retry's did.
    expect(cancelled()).toEqual([id(3), id(4), id(5), id(6)]);
  });

  it("is resumed by a retry after its process died, once the heartbeat is stale", async () => {
    seedDeliveries(3);

    // A run claimed the lease and died before its first batch.
    await claim();

    await expect(reverse.execute(request)).rejects.toMatchObject({
      statusCode: 409,
      code: "IMPORT_REVERSAL_IN_PROGRESS",
    });

    expect(reversalView(record())?.state).toBe("RUNNING");

    // Five minutes of silence later the lease is a dead run's.
    imports.heartbeats.set(
      IMPORT,
      new Date(Date.now() - REVERSAL_STALE_AFTER_MS - 1000),
    );
    record().updated_at = imports.heartbeats.get(IMPORT);

    expect(reversalView(record())?.state).toBe("INTERRUPTED");

    await expect(reverse.execute(request)).resolves.toMatchObject({
      removedDeliveries: 3,
    });

    expect(record().status).toBe("REVERSED");
  });

  it("never lets a run that lost its lease remove or announce anything", async () => {
    seedDeliveries(4);

    const stale = await claim();

    // Taken for dead, and taken over.
    imports.heartbeats.set(
      IMPORT,
      new Date(Date.now() - REVERSAL_STALE_AFTER_MS - 1000),
    );

    const fresh = await claim();

    expect(fresh.lease.getTime()).not.toBe(stale.lease.getTime());

    await expect(
      imports.runReversal(IMPORT, BUSINESS, stale.lease, stale.progress, {
        batchSize: 2,
      }),
    ).rejects.toMatchObject({ code: "IMPORT_REVERSAL_LEASE_LOST" });

    expect(imports.deliveries).toHaveLength(4);

    // The new owner's lease was not released by the loser's failure.
    expect(new Date(record().reversal_started_at!).getTime()).toBe(
      fresh.lease.getTime(),
    );
  });
});

describe("the undo as the HTTP route runs it", () => {
  it(`runs inside the request up to ${REVERSAL_INLINE_LIMIT} deliveries, answering with the result`, async () => {
    seedDeliveries(REVERSAL_INLINE_LIMIT);

    const outcome = await reverse.start(request, new ImportQueue(1, 0));

    expect(outcome.kind).toBe("finished");
    expect(
      outcome.kind === "finished" && outcome.result.removedDeliveries,
    ).toBe(REVERSAL_INLINE_LIMIT);
    expect(record().status).toBe("REVERSED");
    expect(activities).toEqual(["Estornada"]);
  });

  it("goes to the import queue past that, answers 202 with the progress, and finishes there", async () => {
    seedDeliveries(REVERSAL_INLINE_LIMIT + 1);

    const queue = new ImportQueue(1, 1);
    const outcome = await reverse.start(request, queue);

    expect(outcome).toMatchObject({
      kind: "accepted",
      record: {
        id: IMPORT,
        status: "COMPLETED",
        reversal: { state: "RUNNING" },
      },
    });

    // The lease was taken before the answer: a second click follows the
    // run instead of starting another one.
    const again = await reverse.start(request, queue);

    expect(again.kind).toBe("accepted");

    await queue.idle();

    expect(record().status).toBe("REVERSED");
    expect(imports.deliveries).toEqual([]);
    expect(cancelled()).toHaveLength(REVERSAL_INLINE_LIMIT + 1);
    expect(activities).toEqual(["Estornada"]);

    // What the client polls.
    const users = new InMemoryUserRepository();
    users.user.push({
      id: DISPATCHER,
      role: "BUSINESS_ADMIN",
      businessId: BUSINESS,
    } as User);

    const detail = await new GetImportUseCase(users, imports).execute(request);

    expect(detail.status).toBe("REVERSED");
    expect(detail.reversal).toMatchObject({
      state: "DONE",
      removedDeliveries: REVERSAL_INLINE_LIMIT + 1,
      finishedAt: expect.any(String),
    });
    expect(detail).not.toHaveProperty("reversal_started_at");
  });

  it("refuses with 429 IMPORT_BUSY when the replica's queue is full, taking no lease", async () => {
    seedDeliveries(REVERSAL_INLINE_LIMIT + 1);

    const full = new ImportQueue(0, 0);

    await expect(reverse.start(request, full)).rejects.toMatchObject({
      statusCode: 429,
      code: "IMPORT_BUSY",
    });

    expect(record().reversal_started_at ?? null).toBeNull();
    expect(record().reversal ?? null).toBeNull();
  });

  it("still answers 409 for an upload already reversed", async () => {
    seedDeliveries(1);

    await reverse.start(request, new ImportQueue(1, 0));

    await expect(
      reverse.start(request, new ImportQueue(1, 0)),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "IMPORT_ALREADY_REVERSED",
    });
  });
});
