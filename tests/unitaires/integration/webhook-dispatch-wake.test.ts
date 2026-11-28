import { afterEach, describe, expect, it, vi } from "vitest";

import { env } from "@/env";
import { WebhookDispatchService } from "@/shared/integration/webhook-dispatch-service";

/**
 * The webhook dispatcher's wake (plano-escala F3-04).
 *
 * The dispatcher only had its 5 s sweep: a customer's ERP heard about a
 * delivery up to five seconds after it happened, and with the dispatcher in
 * a worker and the request in the api, no wake could reach it at all. Now
 * a fan-out that committed rows wakes the dispatcher of its own process and
 * announces the queue to the others; a hint from another process wakes it
 * too. What this pins:
 *
 *  - only a dispatcher that was started, and only where WORKER_QUEUES
 *    claims `webhooks` (an api's dispatcher is never started);
 *  - a wake during a batch runs one more batch after it, never one per
 *    wake: the batch's last claim may have come before the rows.
 */

const mutableEnv = env as unknown as {
  WORKERS_ENABLED: boolean;
  WORKER_QUEUES: readonly string[];
};
const original = { ...mutableEnv };

const dispatchers: WebhookDispatchService[] = [];

afterEach(async () => {
  for (const dispatcher of dispatchers.splice(0)) {
    await dispatcher.shutdown({ deadlineMs: 0 });
  }

  mutableEnv.WORKERS_ENABLED = original.WORKERS_ENABLED;
  mutableEnv.WORKER_QUEUES = original.WORKER_QUEUES;

  vi.restoreAllMocks();
});

function dispatcherWithClaims(claim: () => Promise<unknown[]>) {
  const dispatcher = new WebhookDispatchService(async () => ({
    allowed: true,
  }));

  dispatchers.push(dispatcher);

  const claims = vi
    .spyOn(
      dispatcher as unknown as { claim: () => Promise<unknown[]> },
      "claim",
    )
    .mockImplementation(claim);

  return { dispatcher, claims };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("WebhookDispatchService.wake()", () => {
  it("does nothing on a dispatcher that was never started", async () => {
    const { dispatcher, claims } = dispatcherWithClaims(async () => []);

    dispatcher.wake();
    await settle();

    expect(claims).not.toHaveBeenCalled();
  });

  it("runs a batch on a started dispatcher that claims the webhooks", async () => {
    const { dispatcher, claims } = dispatcherWithClaims(async () => []);

    await dispatcher.initialize();
    await settle();
    claims.mockClear();

    dispatcher.wake();
    await settle();

    expect(claims).toHaveBeenCalledTimes(1);
  });

  it("does nothing where WORKER_QUEUES leaves the webhooks out", async () => {
    const { dispatcher, claims } = dispatcherWithClaims(async () => []);

    await dispatcher.initialize();
    await settle();
    claims.mockClear();

    mutableEnv.WORKER_QUEUES = ["outbox", "internal", "external", "ai"];
    dispatcher.wake();
    await settle();

    expect(claims).not.toHaveBeenCalled();
  });

  it("runs one more batch after the one in flight, however many wakes came", async () => {
    let release: (() => void) | null = null;
    let calls = 0;

    const { dispatcher, claims } = dispatcherWithClaims(() => {
      calls += 1;

      // The first claim of the first batch hangs until released.
      if (calls === 1) {
        return new Promise<unknown[]>((resolve) => {
          release = () => resolve([]);
        });
      }

      return Promise.resolve([]);
    });

    await dispatcher.initialize();
    await settle();

    expect(claims).toHaveBeenCalledTimes(1);

    dispatcher.wake();
    dispatcher.wake();
    dispatcher.wake();

    release!();
    await settle();

    expect(claims).toHaveBeenCalledTimes(2);
  });
});
