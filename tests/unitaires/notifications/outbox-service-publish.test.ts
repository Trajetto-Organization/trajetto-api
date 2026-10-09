import { beforeEach, describe, expect, it, vi } from "vitest";

import { enterRequestContext, withoutRequestContext } from "@/shared/http/request-context";

/**
 * What `OutboxService` writes for an event (mutation run 06/10: the row's
 * fields had no unit test; only E2E suites reached them). The transaction
 * client and the pipeline are stand-ins; the service is the real one.
 */

const afterCommit = vi.hoisted(() => ({ created: [] as unknown[] }));
const woken = vi.hoisted(() => ({ count: 0 }));

vi.mock("@/../infra/database", () => ({
  default: { domainOutboxEvent: { create: async (args: unknown) => void afterCommit.created.push(args) } },
}));

vi.mock("@/shared/notifications/notification-pipeline-service", () => ({
  NotificationPipelineService: { getInstance: () => ({ wake: () => void (woken.count += 1) }) },
}));

import { OutboxService } from "@/shared/notifications/outbox-service";


const created: Array<{ data: Record<string, unknown> }> = [];
const tx = { domainOutboxEvent: { create: async (args: { data: Record<string, unknown> }) => void created.push(args) } };

const base = {
  topic: "delivery.created",
  aggregateType: "Delivery",
  aggregateId: "delivery-1",
  payload: { deliveryId: "delivery-1" },
} as const;

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

beforeEach(() => {
  created.length = 0;
  afterCommit.created.length = 0;
  woken.count = 0;
});

describe("OutboxService.publish", () => {
  it("writes the row with the caller's key, tenant, actor and correlation", async () => {
    await new OutboxService().publish(tx as never, {
      ...base,
      eventKey: "fixed-key",
      businessId: "business-1",
      actorId: "user-1",
      correlationId: "corr-1",
    } as never);

    expect(created).toEqual([
      {
        data: {
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
  });

  it("defaults the key per execution, nulls the missing ids, and takes the request's id", async () => {
    await withoutRequestContext(async () => {
      enterRequestContext({ requestId: "request-7" });
      await new OutboxService().publish(tx as never, base as never);
    });

    const [{ data }] = created;
    expect(String(data.eventKey)).toMatch(/^delivery\.created:delivery-1:[0-9a-f-]{36}$/);
    expect(data).toMatchObject({ businessId: null, actorId: null, correlationId: "request-7" });
  });

  it("has no correlation outside a request", async () => {
    await withoutRequestContext(() => new OutboxService().publish(tx as never, base as never));

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
    await new OutboxService().publishAfterCommit({ ...base, eventKey: "k" } as never);
    await settle();

    expect(afterCommit.created).toHaveLength(1);
    expect(woken.count).toBe(1);
  });
});
