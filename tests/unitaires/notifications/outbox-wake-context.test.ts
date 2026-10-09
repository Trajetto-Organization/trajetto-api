import { afterEach, describe, expect, it, vi } from "vitest";

import {
  enterRequestContext,
  getRequestContext,
  withoutRequestContext,
} from "@/shared/http/request-context";

/**
 * The outbox's wake timer does not carry the publishing request (INV-12).
 *
 * A publish schedules a wake of the notification pipeline a moment later.
 * The timer was created inside the request, so AsyncLocalStorage handed the
 * request's store — its memo of rows, its request id — to the callback: the
 * store outlived the response until the timer fired, and everything the
 * callback started ran as if still inside that one request.
 */
let seen: unknown = "the wake never ran";

vi.mock("@/../infra/database", () => ({ default: {} }));

vi.mock("@/shared/notifications/notification-pipeline-service", () => ({
  NotificationPipelineService: {
    getInstance: () => ({
      wake: () => {
        seen = getRequestContext();
      },
    }),
  },
}));

afterEach(() => {
  vi.useRealTimers();
});

describe("the pipeline wake scheduled by a publish", () => {
  it("fires outside the request that published", async () => {
    const { OutboxService } = await import(
      "@/shared/notifications/outbox-service"
    );

    const outbox = new OutboxService() as unknown as {
      wakePipeline: (delayMs: number) => void;
    };

    await withoutRequestContext(async () => {
      enterRequestContext({ requestId: "request-that-published" });

      outbox.wakePipeline(0);

      // The timer, then the dynamic import behind it.
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(seen).toBeUndefined();
  });
});
