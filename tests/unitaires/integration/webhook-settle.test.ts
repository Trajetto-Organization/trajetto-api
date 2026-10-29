import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A 200 whose record fails to write.
 *
 * The write that records DELIVERED ran inside the same `try` as the fetch. A
 * database blip at that instant fell into the network `catch`, which
 * scheduled a retry: the customer, who had already answered 200, received the
 * event again thirty seconds later. The notification pipeline fixed the same
 * bug by retrying the success write; the dispatcher had not.
 *
 * The database is a stub here, so a single failed write can be staged.
 */
const db = vi.hoisted(() => {
  const writes: Array<{ via: string; data: Record<string, unknown> }> = [];
  let failuresLeft = 0;

  const failOnce = () => {
    if (failuresLeft > 0) {
      failuresLeft -= 1;
      throw new Error("Connection terminated unexpectedly");
    }
  };

  const database: Record<string, unknown> = {
    webhookEndpoint: {
      findUnique: vi.fn(async () => ({
        id: "endpoint-1",
        url: "https://erp.exemplo.com.br/hook",
        secret: "whsec_teste",
        headers: null,
        is_active: true,
        disabled_at: null,
      })),
      update: vi.fn(async (args: { data: Record<string, unknown> }) => {
        writes.push({ via: "endpoint.update", data: args.data });
        return { consecutive_failures: 1, disabled_at: null };
      }),
      updateMany: vi.fn(async (args: { data: Record<string, unknown> }) => {
        writes.push({ via: "endpoint.updateMany", data: args.data });
        return { count: 1 };
      }),
    },
    webhookDelivery: {
      findUnique: vi.fn(async () => ({
        payload: {},
        signature: "",
        signed_body: '{"id":"e1","topic":"delivery.delivered"}',
        sourceEventId: "e1",
      })),
      update: vi.fn(async (args: { data: Record<string, unknown> }) => {
        writes.push({ via: "delivery.update", data: args.data });
        return {};
      }),
      updateMany: vi.fn(async (args: { data: Record<string, unknown> }) => {
        failOnce();
        writes.push({ via: "delivery.updateMany", data: args.data });
        return { count: 1 };
      }),
    },
    $transaction: vi.fn(async (work: unknown) => {
      failOnce();

      if (typeof work === "function")
        return (work as (tx: unknown) => unknown)(database);

      return Promise.all(work as Promise<unknown>[]);
    }),
    $executeRaw: vi.fn(async () => 0),
    $queryRaw: vi.fn(async () => []),
  };

  return {
    database,
    writes,
    failNextWrite: () => {
      failuresLeft = 1;
    },
  };
});

vi.mock("@/../infra/database", () => ({ default: db.database }));

import { WebhookDispatchService } from "@/shared/integration/webhook-dispatch-service";

beforeEach(() => {
  db.writes.length = 0;
});

describe("a send the receiver accepted", () => {
  it("is recorded as delivered even when the first write fails, and never retried", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));

    const service = new WebhookDispatchService(
      async () => ({ allowed: true }),
      {
        fetchImpl: fetchImpl as never,
      },
    );

    db.failNextWrite();

    await (
      service as unknown as {
        deliver(row: object): Promise<void>;
      }
    ).deliver({
      id: "row-1",
      endpointId: "endpoint-1",
      topic: "delivery.delivered",
      payload: {},
      attempts: 1,
      created_at: new Date(),
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const statuses = db.writes
      .filter((write) => write.via.startsWith("delivery."))
      .map((write) => write.data.status);

    expect(
      statuses,
      "a falha ao gravar o 200 virou uma retentativa: o receptor recebe o evento de novo",
    ).not.toContain("PENDING");

    expect(statuses).toContain("DELIVERED");
  }, 10_000);
});
