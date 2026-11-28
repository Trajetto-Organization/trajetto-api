import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  enterRequestContext,
  withoutRequestContext,
} from "@/shared/http/request-context";

/**
 * What `OutboxService` writes for an event (mutation run 06/10: the row's
 * fields had no unit test; only E2E suites reached them). The transaction
 * client and the pipeline are stand-ins; the service is the real one.
 */

const afterCommit = vi.hoisted(() => ({
  created: [] as unknown[],
  many: [] as Array<{ data: unknown[]; skipDuplicates?: boolean }>,
  // The keys outbox_event_key holds (plano-escala F5-02), with the event
  // each one names: the INSERT ... ON CONFLICT DO NOTHING of publishOnce
  // returns nothing for one already there, as Postgres does.
  keys: new Map<string, string>(),
  keyRows: [] as unknown[],
  transactions: 0,
}));
const woken = vi.hoisted(() => ({ count: 0 }));

vi.mock("@/../infra/database", () => {
  const client = {
    domainOutboxEvent: {
      create: async (args: unknown) => void afterCommit.created.push(args),
      createMany: async (args: {
        data: Array<{ eventKey: string }>;
        skipDuplicates?: boolean;
      }) => {
        afterCommit.many.push(args);

        return { count: args.data.length };
      },
    },
    outboxEventKey: {
      create: async (args: unknown) => void afterCommit.keyRows.push(args),
    },
    // publishOnce's key: taken (one row back) or already there (none).
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (!strings.join("?").includes('INSERT INTO "outbox_event_key"')) {
        return [];
      }

      const [key, eventId] = values as [string, string];

      if (afterCommit.keys.has(key)) return [];

      afterCommit.keys.set(key, eventId);

      return [{ event_id: eventId }];
    },
  };

  return {
    default: {
      ...client,
      $transaction: async (work: (tx: unknown) => Promise<unknown>) => {
        afterCommit.transactions += 1;

        return work(client);
      },
    },
  };
});

vi.mock("@/shared/notifications/notification-pipeline-service", () => ({
  NotificationPipelineService: {
    getInstance: () => ({ wake: () => void (woken.count += 1) }),
  },
}));

import { OutboxService } from "@/shared/notifications/outbox-service";

const created: Array<{ data: Record<string, unknown> }> = [];
const keyRows: Array<{ data: Record<string, unknown> }> = [];
const tx = {
  domainOutboxEvent: {
    create: async (args: { data: Record<string, unknown> }) =>
      void created.push(args),
  },
  outboxEventKey: {
    create: async (args: { data: Record<string, unknown> }) =>
      void keyRows.push(args),
  },
};

const base = {
  topic: "delivery.created",
  aggregateType: "Delivery",
  aggregateId: "delivery-1",
  payload: { deliveryId: "delivery-1" },
} as const;

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

beforeEach(() => {
  created.length = 0;
  keyRows.length = 0;
  afterCommit.created.length = 0;
  afterCommit.many.length = 0;
  afterCommit.keys.clear();
  afterCommit.keyRows.length = 0;
  afterCommit.transactions = 0;
  woken.count = 0;
});

describe("OutboxService.publish", () => {
  it("writes the row with the caller's key, tenant, actor and correlation", async () => {
    await new OutboxService().publish(
      tx as never,
      {
        ...base,
        eventKey: "fixed-key",
        businessId: "business-1",
        actorId: "user-1",
        correlationId: "corr-1",
      } as never,
    );

    expect(created).toEqual([
      {
        data: {
          id: expect.any(String),
          eventKey: "fixed-key",
          topic: "delivery.created",
          aggregateType: "Delivery",
          aggregateId: "delivery-1",
          businessId: "business-1",
          actorId: "user-1",
          payload: { deliveryId: "delivery-1" },
          correlationId: "corr-1",
        },
      },
    ]);

    // plano-escala F5-02: the caller's key gets its own row, naming the
    // event, in the same transaction.
    expect(keyRows).toEqual([
      { data: { event_key: "fixed-key", event_id: created[0].data.id } },
    ]);
  });

  it("defaults the key per execution, nulls the missing ids, and takes the request's id", async () => {
    await withoutRequestContext(async () => {
      enterRequestContext({ requestId: "request-7" });
      await new OutboxService().publish(tx as never, base as never);
    });

    const [{ data }] = created;
    expect(String(data.eventKey)).toMatch(
      /^delivery\.created:delivery-1:[0-9a-f-]{36}$/,
    );
    // A random key never collides: no key row (F5-02).
    expect(keyRows).toEqual([]);
    expect(data).toMatchObject({
      businessId: null,
      actorId: null,
      correlationId: "request-7",
    });
  });

  it("has no correlation outside a request", async () => {
    await withoutRequestContext(() =>
      new OutboxService().publish(tx as never, base as never),
    );

    expect(created[0].data.correlationId).toBeNull();
  });

  it("wakes the pipeline shortly after", async () => {
    vi.useFakeTimers();
    try {
      await new OutboxService().publish(tx as never, base as never);
      expect(woken.count).toBe(0);
      await vi.advanceTimersByTimeAsync(500);
    } finally {
      vi.useRealTimers();
    }
    await settle();

    expect(woken.count).toBe(1);
  });
});

describe("OutboxService.publishAfterCommit", () => {
  it("writes through the database client and wakes the pipeline", async () => {
    await new OutboxService().publishAfterCommit({
      ...base,
      eventKey: "k",
    } as never);
    await settle();

    expect(afterCommit.created).toHaveLength(1);
    // The event and its key, in one transaction of their own (F5-02).
    expect(afterCommit.transactions).toBe(1);
    expect(afterCommit.keyRows).toHaveLength(1);
    expect(woken.count).toBe(1);
  });
});

/**
 * A notice whose only write is the event (wave 3.7: a driver's route record
 * with no active branch, told to the dispatcher once per route and moment).
 * The insert skips a key already there, so retries never fail on the unique
 * key and never write a second row; only a written row wakes the pipeline.
 */
describe("OutboxService.publishOnce", () => {
  const notice = {
    ...base,
    eventKey: "route.record_branch_missing:route-1:ROUTE_START",
    businessId: "business-1",
    actorId: "driver-user-1",
  };

  it("writes the row once per key, through the key's own row, and says whether it wrote", async () => {
    const outbox = new OutboxService();

    const first = await withoutRequestContext(() =>
      outbox.publishOnce(notice as never),
    );
    const again = await withoutRequestContext(() =>
      outbox.publishOnce(notice as never),
    );
    await settle();

    expect([first, again]).toEqual([true, false]);
    // The second call stopped at the key: no second event insert.
    expect(afterCommit.many).toHaveLength(1);
    expect(afterCommit.many[0]).toEqual({
      data: [
        {
          id: afterCommit.keys.get(notice.eventKey),
          eventKey: notice.eventKey,
          topic: "delivery.created",
          aggregateType: "Delivery",
          aggregateId: "delivery-1",
          businessId: "business-1",
          actorId: "driver-user-1",
          payload: { deliveryId: "delivery-1" },
          correlationId: null,
        },
      ],
      skipDuplicates: true,
    });
    // Only the row that was written woke the pipeline.
    expect(woken.count).toBe(1);
  });
});
