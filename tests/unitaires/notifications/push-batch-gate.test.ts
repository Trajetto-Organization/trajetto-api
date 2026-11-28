import { afterEach, describe, expect, it, vi } from "vitest";

import { PushBatchGate } from "@/shared/notifications/push-batch-gate";
import type {
  PushBatchOutcome,
  PushRequest,
} from "@/shared/notifications/push-provider";

/**
 * Where the push rows of one group meet before their call to Expo
 * (plano-escala U-06).
 *
 * Each row runs its own delivery and only the send is shared, so the gate
 * decides when the call goes and who gets which outcome. A row that failed
 * before the send must not keep the others waiting, a slow one must not
 * hold them past a bound, and a row must never receive another row's
 * outcome: a ticket on the wrong delivery is a receipt lost.
 */
afterEach(() => {
  vi.useRealTimers();
});

function request(name: string): PushRequest {
  return {
    tokens: [`ExponentPushToken[${name}]`],
    content: { title: name, body: name, data: { deliveryId: name } },
  };
}

/** A sender that answers each request with a ticket named after it. */
function recordingSender() {
  const calls: PushRequest[][] = [];

  const send = vi.fn(async (requests: PushRequest[]) => {
    calls.push(requests);

    return requests.map((item): PushBatchOutcome => ({
      ok: true,
      result: {
        deliveredAny: true,
        invalidTokens: [],
        tickets: [
          { id: `ticket-${item.content.title}`, token: item.tokens[0] },
        ],
      },
    }));
  });

  return { calls, send };
}

describe("a push group's gate", () => {
  it("sends once every member handed its request, each getting its own result", async () => {
    const { calls, send } = recordingSender();
    const gate = new PushBatchGate(["a", "b", "c"], send, 60_000);

    const a = gate.submit("a", request("a"));
    const b = gate.submit("b", request("b"));

    expect(send).not.toHaveBeenCalled();

    const c = gate.submit("c", request("c"));

    const results = await Promise.all([a, b, c]);

    expect(send).toHaveBeenCalledTimes(1);
    expect(calls[0].map((item) => item.content.title)).toEqual(["a", "b", "c"]);
    expect(results.map((result) => result.tickets[0].id)).toEqual([
      "ticket-a",
      "ticket-b",
      "ticket-c",
    ]);
  });

  it("does not wait for a member that left before the send", async () => {
    const { calls, send } = recordingSender();
    const gate = new PushBatchGate(["a", "b"], send, 60_000);

    const a = gate.submit("a", request("a"));

    // b failed its own checks (no device, access revoked): it never sends.
    gate.leave("b");

    await expect(a).resolves.toMatchObject({
      tickets: [{ id: "ticket-a" }],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(1);
  });

  it("sends nothing when every member left", () => {
    const { send } = recordingSender();
    const gate = new PushBatchGate(["a", "b"], send, 60_000);

    gate.leave("a");
    gate.leave("b");

    expect(send).not.toHaveBeenCalled();
  });

  it("goes without a slow member at the bound, and sends that member on its own when it arrives", async () => {
    vi.useFakeTimers();

    const { calls, send } = recordingSender();
    const gate = new PushBatchGate(["a", "slow"], send, 2_000);

    const a = gate.submit("a", request("a"));

    await vi.advanceTimersByTimeAsync(1_999);
    expect(send).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await expect(a).resolves.toMatchObject({ tickets: [{ id: "ticket-a" }] });
    expect(calls).toEqual([[request("a")]]);

    // The slow member gets there after the group went: a call of its own,
    // never a second copy of the group's.
    await expect(gate.submit("slow", request("slow"))).resolves.toMatchObject({
      tickets: [{ id: "ticket-slow" }],
    });
    expect(calls).toEqual([[request("a")], [request("slow")]]);

    // Leaving after the group went changes nothing.
    gate.leave("slow");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("hands each member its own failure, and the others their results", async () => {
    const send = vi.fn(
      async (requests: PushRequest[]): Promise<PushBatchOutcome[]> =>
        requests.map((item) =>
          item.content.title === "b"
            ? {
                ok: false,
                error: Object.assign(
                  new Error("Expo push respondeu HTTP 400"),
                  {
                    httpStatus: 400,
                  },
                ),
              }
            : {
                ok: true,
                result: { deliveredAny: true, invalidTokens: [], tickets: [] },
              },
        ),
    );

    const gate = new PushBatchGate(["a", "b"], send, 60_000);

    const a = gate.submit("a", request("a"));
    const b = gate.submit("b", request("b"));

    await expect(a).resolves.toMatchObject({ deliveredAny: true });
    await expect(b).rejects.toMatchObject({ httpStatus: 400 });
  });

  it("rejects every member when the send itself throws", async () => {
    const send = vi.fn(async () => {
      throw new Error("boom");
    });

    const gate = new PushBatchGate(["a", "b"], send, 60_000);

    const a = gate.submit("a", request("a"));
    const b = gate.submit("b", request("b"));

    await expect(a).rejects.toThrow("boom");
    await expect(b).rejects.toThrow("boom");
  });
});
