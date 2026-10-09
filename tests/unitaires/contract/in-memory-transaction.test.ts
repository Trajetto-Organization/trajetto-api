import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  inMemoryTransaction,
  type InMemoryTransaction,
} from "@/shared/in-memory/in-memory-transaction";

import { ReviewProofAuditUseCase } from "@/modules/delivery/usecases/review-proof-audit/review-proof-audit-usecase";
import { InMemoryProofAuditRepository } from "@/modules/delivery/repositories/in-memory/in-memory-proof-audit-repository";
import { InMemoryDeliveryRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-repository";
import { InMemoryOccurrenceTypeRepository } from "@/modules/occurrence-type/repositories/in-memory/in-memory-occurrence-type-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryWebhookFanOutService } from "@/shared/integration/in-memory/in-memory-webhook-fan-out-service";

import { InMemoryServiceOrderRepository } from "@/modules/service-order/repositories/in-memory/in-memory-service-order-repository";

import type { NotificationService } from "@/shared/services/notification-service";
import type { ServiceOrder } from "@/modules/service-order/dtos/service-order-dto";
import type { User } from "@/modules/user/dtos/user-dto";

/**
 * TEST-PAR-7: the twins' transaction rolls back on throw, so a transactional
 * use case's atomicity is provable in a unit test. The old mock — `run({})`
 * — kept whatever the callback wrote before it failed.
 */

// The use case imports the real client; the test decides which transaction
// it gets, per case.
const tx = vi.hoisted(() => ({
  current: {
    $transaction: async (run: (client: unknown) => Promise<unknown>) => run({}),
  } as {
    $transaction: (
      run: (client: unknown) => Promise<unknown>,
    ) => Promise<unknown>;
  },
}));

vi.mock("@/../infra/database", () => ({
  default: {
    $transaction: (run: (client: unknown) => Promise<unknown>) =>
      tx.current.$transaction(run),
  },
}));

vi.mock("@/websocket", () => ({ sendCatalogChangedEvent: vi.fn() }));

class FakeTwin {
  public rows: Array<{ id: string; status: string; tags: string[] }> = [];
  public byKey = new Map<string, string>();
  public seen = new Set<string>();
  public sequence = 0;
  private hidden: string[] = [];

  async write(id: string, fail = false) {
    this.rows.push({ id, status: "NEW", tags: [] });
    this.byKey.set(id, id);
    this.seen.add(id);
    this.sequence += 1;
    this.hidden.push(id);

    if (fail) throw new Error("second write failed");
  }

  hiddenRows() {
    return [...this.hidden];
  }
}

describe("inMemoryTransaction", () => {
  let twin: FakeTwin;
  let transaction: InMemoryTransaction<unknown>;

  beforeEach(() => {
    twin = new FakeTwin();
    twin.rows.push({ id: "kept", status: "OPEN", tags: ["a"] });
    transaction = inMemoryTransaction([twin]);
  });

  it("keeps the writes of a callback that returns", async () => {
    await transaction.$transaction(async () => twin.write("one"));

    expect(twin.rows.map((row) => row.id)).toEqual(["kept", "one"]);
    expect(transaction.stats).toEqual({ committed: 1, rolledBack: 0 });
  });

  it("undoes inserts, in-place row edits, Maps, Sets, counters and private stores on throw", async () => {
    const rows = twin.rows;
    const kept = twin.rows[0];

    await expect(
      transaction.$transaction(async () => {
        kept.status = "CLOSED";
        kept.tags.push("b");
        await twin.write("one");
        await twin.write("two", true);
      }),
    ).rejects.toThrow("second write failed");

    expect(twin.rows).toBe(rows); // same array: twins share them
    expect(twin.rows).toEqual([{ id: "kept", status: "OPEN", tags: ["a"] }]);
    expect(twin.rows[0]).toBe(kept);
    expect([...twin.byKey]).toEqual([]);
    expect([...twin.seen]).toEqual([]);
    expect(twin.sequence).toBe(0);
    expect(twin.hiddenRows()).toEqual([]);
    expect(transaction.stats).toEqual({ committed: 0, rolledBack: 1 });
  });

  it("undoes a delete that reassigns the store (this.x = this.x.filter(...))", async () => {
    class ReassigningTwin {
      public parts = ["a", "b"];
      public byOrder = new Map([["o1", "a"]]);

      async remove(id: string) {
        this.parts = this.parts.filter((part) => part !== id);
        this.byOrder = new Map();
      }
    }

    const reassigning = new ReassigningTwin();
    const parts = reassigning.parts;
    const byOrder = reassigning.byOrder;

    await expect(
      inMemoryTransaction([reassigning]).$transaction(async () => {
        await reassigning.remove("a");
        throw new Error("later write failed");
      }),
    ).rejects.toThrow("later write failed");

    expect(reassigning.parts).toEqual(["a", "b"]);
    expect(reassigning.parts).toBe(parts);
    expect([...reassigning.byOrder]).toEqual([["o1", "a"]]);
    expect(reassigning.byOrder).toBe(byOrder);
  });

  it("rolls back the service order twin's cascade delete of parts", async () => {
    const orders = new InMemoryServiceOrderRepository();
    const ORDER = "018f0000-0000-7000-8000-0000000000c1";
    const BUSINESS = "018f0000-0000-7000-8000-0000000000c2";
    orders.serviceOrders.push({
      id: ORDER,
      businessId: BUSINESS,
      completion_date: null,
    } as unknown as ServiceOrder);
    orders.parts.push(
      { serviceOrderId: ORDER, unit_price: 10, quantity: 1 },
      { serviceOrderId: "other", unit_price: 5, quantity: 2 },
    );
    const parts = orders.parts;

    await expect(
      inMemoryTransaction([orders]).$transaction(async () => {
        await orders.deleteServiceOrderGuarded(ORDER, BUSINESS);
        throw new Error("audit write failed");
      }),
    ).rejects.toThrow("audit write failed");

    expect(orders.serviceOrders.map((order) => order.id)).toEqual([ORDER]);
    expect(orders.parts).toBe(parts);
    expect(orders.parts.map((part) => part.serviceOrderId)).toEqual([
      ORDER,
      "other",
    ]);
  });

  it("hands the callback the transaction client", async () => {
    const client = { name: "tx" };
    const seen = await inMemoryTransaction([twin], client).$transaction(
      async (given) => given,
    );

    expect(seen).toBe(client);
  });
});

describe("a transactional use case over the twins", () => {
  const BUSINESS = "018f0000-0000-7000-8000-00000000000b";
  const REVIEWER = "018f0000-0000-7000-8000-0000000000a1";
  const DELIVERY = "018f0000-0000-7000-8000-0000000000e1";

  function makeReview() {
    const users = new InMemoryUserRepository();
    users.user.push({
      id: REVIEWER,
      role: "BUSINESS_ADMIN",
      businessId: BUSINESS,
    } as User);

    const audits = new InMemoryProofAuditRepository();
    // The delivery is NOT in the delivery twin: the rejection's occurrence
    // write fails (P2025, as tenantOfDelivery does in Postgres) after the
    // verdict and the webhook were already written in the same callback.
    const deliveries = new InMemoryDeliveryRepository();
    const occurrenceTypes = new InMemoryOccurrenceTypeRepository();
    const webhooks = new InMemoryWebhookFanOutService();

    const review = new ReviewProofAuditUseCase(
      users,
      audits,
      deliveries,
      occurrenceTypes,
      {
        createActivityIfEnabled: async () => undefined,
      } as unknown as NotificationService,
      webhooks.asService(),
    );

    return { review, audits, deliveries, occurrenceTypes, webhooks };
  }

  const reject = (review: ReviewProofAuditUseCase, auditId: string) =>
    review.execute({
      userId: REVIEWER,
      businessId: BUSINESS,
      auditId,
      status: "REJECTED",
      rejection_reason: "Canhoto de outra entrega",
    });

  it("under the old passthrough, a failed occurrence leaves the verdict and the webhook behind", async () => {
    const { review, audits, webhooks } = makeReview();
    const card = await audits.enqueue(DELIVERY, BUSINESS);

    tx.current = { $transaction: async (run) => run({}) };

    await expect(reject(review, card.id)).rejects.toMatchObject({
      code: "P2025",
    });

    // What Postgres would never show: a REJECTED card with no occurrence.
    expect(audits.audits[0].status).toBe("REJECTED");
    expect(webhooks.announced).toHaveLength(1);
  });

  it("with the rolling-back transaction, the verdict and the webhook go back with the failed write", async () => {
    const { review, audits, deliveries, occurrenceTypes, webhooks } =
      makeReview();
    const card = await audits.enqueue(DELIVERY, BUSINESS);

    tx.current = inMemoryTransaction([
      audits,
      deliveries,
      occurrenceTypes,
      webhooks,
    ]);

    await expect(reject(review, card.id)).rejects.toMatchObject({
      code: "P2025",
    });

    expect(audits.audits[0]).toMatchObject({
      status: "PENDING",
      reviewedById: null,
    });
    expect(webhooks.announced).toEqual([]);
    expect(deliveries.occurrences).toEqual([]);
  });
});
