import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WebhookFanOutService } from "@/shared/integration/webhook-fan-out-service";

import { clearLogged, logged } from "../../support/log-capture";

const fanOut = vi.fn();

vi.mock("@/shared/integration/webhook-dispatch-service", () => ({
  fanOutWebhookEvent: (...args: unknown[]) => fanOut(...args),
}));

vi.mock("@/shared/logging/logger", async (importOriginal) =>
  (await import("../../support/log-capture")).capturingLogger(
    await importOriginal(),
  ),
);

/**
 * The one place that decides whether a broken integration can cost somebody a
 * write.
 *
 * Nine use cases call `announce` and not one of them wraps it in a try. That
 * is on purpose — nine copies of the same catch is nine chances to get it
 * wrong — but it makes this file load-bearing: delete the catch below and a
 * driver standing at a door loses a proof because a customer's Postgres row
 * could not be written.
 */
describe("announcing an event to the customers' systems", () => {
  let service: WebhookFanOutService;

  beforeEach(() => {
    fanOut.mockReset();
    fanOut.mockResolvedValue(1);

    clearLogged();

    service = new WebhookFanOutService();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes the topic, the tenant and the payload straight through", async () => {
    await service.announce("route.started", "business-1", { route_id: "r1" });

    expect(fanOut).toHaveBeenCalledTimes(1);
    expect(fanOut.mock.calls[0][0]).toEqual({
      topic: "route.started",
      businessId: "business-1",
      payload: { route_id: "r1" },
    });
  });

  it("hands the caller's transaction down, so the row commits with the fact", async () => {
    const tx = { marker: "the caller's client" };

    await service.announce("delivery.created", "business-1", {}, tx as never);

    // Not a detail: a fan-out that opened its own connection would write the
    // event whether or not the delivery it describes survived the commit.
    expect(fanOut.mock.calls[0][1]).toBe(tx);
  });

  it("swallows a failure when there is no transaction to poison", async () => {
    fanOut.mockRejectedValue(new Error("endpoint table is gone"));

    // A dispatcher releasing a route does not care that a customer has no
    // endpoint configured, and an integration must never be able to fail an
    // operation that already happened.
    await expect(
      service.announce("route.released", "business-1", {}),
    ).resolves.toBeUndefined();

    expect(logged("error")).toHaveLength(1);
    expect(logged("error")[0]).toMatchObject({
      topic: "route.released",
      businessId: "business-1",
    });
  });

  it("rethrows inside a transaction, because half a write is worse", async () => {
    fanOut.mockRejectedValue(new Error("deadlock detected"));

    const tx = {};

    // The opposite rule, and for the same reason. Inside a transaction the
    // connection is already poisoned — swallowing would commit the delivery
    // and drop the event silently, which is precisely the state moving these
    // calls into the transaction was meant to end.
    await expect(
      service.announce("delivery.delivered", "business-1", {}, tx as never),
    ).rejects.toThrow("deadlock detected");

    expect(logged()).toHaveLength(0);
  });
});
