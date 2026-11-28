import { describe, expect, it } from "vitest";

import {
  REPLAY_WINDOW_EXPIRED_REASON,
  ENDPOINT_PAUSED_REASON,
  RESPONSE_BODY_LIMIT,
  RESPONSE_READ_LIMIT_BYTES,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_RETRY_DELAYS_MS,
  assertWebhookLeaseInvariant,
  isOutsideReplayWindow,
  isWebhookSuccess,
  parkedUntil,
  truncateResponseBody,
} from "@/shared/integration/webhook-dispatch-rules";

/**
 * The webhook dispatcher's limits and boundaries, by value (mutation run
 * 06/10: the retry table, the 2xx boundary, the lease boundary, the replay
 * window and the stored body's limit could change with every test green).
 */

const DAY = 86_400_000;
const T = new Date("2026-10-06T12:00:00.000Z");

describe("schedule and limits", () => {
  it("retries for six hours over five delays, plus the first attempt", () => {
    expect(WEBHOOK_RETRY_DELAYS_MS).toEqual([
      30_000, 120_000, 600_000, 3_600_000, 21_600_000,
    ]);
    expect(WEBHOOK_MAX_ATTEMPTS).toBe(6);
    expect(RESPONSE_READ_LIMIT_BYTES).toBe(8192);
  });

  it("words the paused and expired states with the 30-day window", () => {
    expect(ENDPOINT_PAUSED_REASON).toBe(
      "Endpoint pausado ou desligado: o evento aguarda a reativação (até 30 dias).",
    );
    expect(REPLAY_WINDOW_EXPIRED_REASON).toBe(
      "O evento passou 30 dias sem poder ser entregue e foi encerrado.",
    );
  });
});

describe("isWebhookSuccess", () => {
  it("is 200 to 299 only", () => {
    expect([199, 200, 299, 300].map(isWebhookSuccess)).toEqual([
      false,
      true,
      true,
      false,
    ]);
  });
});

describe("assertWebhookLeaseInvariant", () => {
  it("refuses a worst case equal to the lease, with the numbers", () => {
    // 4 rounds of the claim, plus the call of a claim before it (F3-07).
    expect(() => assertWebhookLeaseInvariant(4, 1, 10_000, 50, 1, 1)).toThrow(
      "Webhook lease invariant violated: a batch of 4 at concurrency 1 can take 50000ms, which does not fit in the 50s lease. Raise the lease or lower the batch.",
    );
    expect(() =>
      assertWebhookLeaseInvariant(4, 1, 10_000, 51, 1, 1),
    ).not.toThrow();
  });

  it("bounds one endpoint's share by the batch it is in", () => {
    // 2 rows, at most 10 of one endpoint, 1 call at a time: 2 rounds, not
    // 10, plus the one before.
    expect(() =>
      assertWebhookLeaseInvariant(2, 5, 10_000, 31, 10, 1),
    ).not.toThrow();
    expect(() => assertWebhookLeaseInvariant(2, 5, 10_000, 30, 10, 1)).toThrow(
      /lease invariant/,
    );
  });
});

describe("truncateResponseBody", () => {
  it("keeps a body of exactly the limit and drops NUL characters", () => {
    const exact = "x".repeat(RESPONSE_BODY_LIMIT);

    expect(truncateResponseBody(exact)).toBe(exact);
    expect(truncateResponseBody(`${exact}y`)).toBe(`${exact}… (truncado)`);
    expect(truncateResponseBody("a\u0000b")).toBe("ab");
  });
});

describe("the replay window", () => {
  it("parks a held row for thirty days from its creation", () => {
    expect(parkedUntil(T).getTime()).toBe(T.getTime() + 30 * DAY);
  });

  it("ends exactly thirty days after the creation", () => {
    expect(isOutsideReplayWindow(T, new Date(T.getTime() + 30 * DAY - 1))).toBe(
      false,
    );
    expect(isOutsideReplayWindow(T, new Date(T.getTime() + 30 * DAY))).toBe(
      true,
    );
  });
});
