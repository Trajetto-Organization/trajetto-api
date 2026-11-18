import { describe, expect, it } from "vitest";

import {
  MAX_CONSECUTIVE_FAILURES,
  REPLAY_WINDOW_DAYS,
  RESPONSE_BODY_LIMIT,
  WEBHOOK_CONCURRENCY,
  WEBHOOK_ENDPOINT_GLOBAL_CONCURRENCY,
  WEBHOOK_LEASE_SECONDS,
  WEBHOOK_PER_ENDPOINT_CONCURRENCY,
  WEBHOOK_RETRY_DELAYS_MS,
  WEBHOOK_TIMEOUT_MS,
  assertWebhookLeaseInvariant,
  destinationHostOf,
  endpointShare,
  isWebhookPermanent,
  isWebhookSuccess,
  nextWebhookDelayMs,
  truncateResponseBody,
} from "@/shared/integration/webhook-dispatch-rules";

/**
 * When a customer's endpoint is retried, given up on, and switched off.
 *
 * Every number here is a promise to somebody else's on-call engineer: how long
 * their outage can last before events are lost, and how many failures it takes
 * before we stop calling them. Getting them wrong is invisible until the day
 * an integration silently misses a morning's deliveries.
 */
describe("what their answer means", () => {
  it("treats the 2xx range as success", () => {
    for (const status of [200, 201, 202, 204, 299]) {
      expect(isWebhookSuccess(status), String(status)).toBe(true);
    }
  });

  it("does not treat a redirect as success", () => {
    // A 302 to a login page is the most common way an integration silently
    // stops working, and counting it as delivered would hide that forever.
    expect(isWebhookSuccess(302)).toBe(false);
  });

  it("honours 410 Gone as 'stop sending me this'", () => {
    // The one refusal a well-behaved receiver uses to unsubscribe itself, and
    // honouring it is the difference between an integration and a nuisance.
    expect(isWebhookPermanent(410)).toBe(true);
  });

  it("keeps retrying every other 4xx", () => {
    // A 404 or a 401 is THEIR bug — a wrong route, an expired credential — and
    // retrying gives them the window to fix it without losing the event.
    for (const status of [400, 401, 403, 404, 422, 429]) {
      expect(isWebhookPermanent(status), String(status)).toBe(false);
    }
  });

  it("keeps retrying a timeout", () => {
    expect(isWebhookPermanent(null)).toBe(false);
  });
});

describe("the retry schedule", () => {
  it("covers a working day's accident", () => {
    // Thirty minutes would drop events during an outage nobody was even paged
    // for. The last step reaches six hours on purpose.
    const total = WEBHOOK_RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0);

    expect(total).toBeGreaterThan(6 * 60 * 60_000);
  });

  it("starts fast and slows down", () => {
    // A restart should be covered in seconds; a real outage should not be
    // hammered every thirty seconds for six hours.
    for (let index = 1; index < WEBHOOK_RETRY_DELAYS_MS.length; index += 1) {
      expect(WEBHOOK_RETRY_DELAYS_MS[index]).toBeGreaterThan(
        WEBHOOK_RETRY_DELAYS_MS[index - 1],
      );
    }

    expect(WEBHOOK_RETRY_DELAYS_MS[0]).toBeLessThanOrEqual(60_000);
  });

  it("gives up after the last step, rather than forever", () => {
    expect(nextWebhookDelayMs(1)).toBe(WEBHOOK_RETRY_DELAYS_MS[0]);

    expect(nextWebhookDelayMs(WEBHOOK_RETRY_DELAYS_MS.length)).toBe(
      WEBHOOK_RETRY_DELAYS_MS[WEBHOOK_RETRY_DELAYS_MS.length - 1],
    );

    // Exhausted: the row becomes FAILED and stays resendable by hand.
    expect(nextWebhookDelayMs(WEBHOOK_RETRY_DELAYS_MS.length + 1)).toBeNull();
  });
});

describe("the lease invariant", () => {
  it("holds for the batch the service actually uses", () => {
    // A batch that cannot finish inside its lease means a second replica
    // reclaims rows the first is still sending, and the customer's system
    // receives every event twice.
    expect(() => assertWebhookLeaseInvariant(20)).not.toThrow();
  });

  it("fails loudly when somebody raises the batch without the lease", () => {
    // The point of asserting it at load time: this failure has to happen on a
    // developer's machine, not in production as duplicate events.
    expect(() => assertWebhookLeaseInvariant(500)).toThrow(
      /lease invariant violated/i,
    );
  });

  it("keeps the timeout comfortably inside the lease", () => {
    // A customer's hanging endpoint must not be able to hold our worker past
    // the point where another replica reclaims the row.
    expect(WEBHOOK_TIMEOUT_MS * 2).toBeLessThan(WEBHOOK_LEASE_SECONDS * 1000);
    expect(WEBHOOK_CONCURRENCY).toBeGreaterThan(1);
  });
});

describe("switching a dead endpoint off", () => {
  it("tolerates a flaky endpoint but not a dead one", () => {
    // Not zero and not infinite: a dead URL costs every event a ten-second
    // timeout, which at a hundred events an hour is a worker doing nothing
    // else.
    expect(MAX_CONSECUTIVE_FAILURES).toBeGreaterThan(5);
    expect(MAX_CONSECUTIVE_FAILURES).toBeLessThan(100);
  });
});

describe("what we keep of their answer", () => {
  it("keeps a short body whole", () => {
    expect(truncateResponseBody("erro: rota inválida")).toBe(
      "erro: rota inválida",
    );
  });

  it("truncates a megabyte of somebody's HTML error page", () => {
    // Multiplied by every event of the day, forever, in the table the monitor
    // reads.
    const huge = "x".repeat(RESPONSE_BODY_LIMIT * 10);

    const kept = truncateResponseBody(huge);

    expect(kept.length).toBeLessThan(RESPONSE_BODY_LIMIT + 50);
    expect(kept).toContain("truncado");
  });

  it("keeps the FIRST kilobyte, which is where the error is", () => {
    const body = `erro de verdade${"x".repeat(RESPONSE_BODY_LIMIT * 2)}`;

    expect(truncateResponseBody(body)).toContain("erro de verdade");
  });
});

describe("the replay window", () => {
  it("is the thirty days the contract promises", () => {
    // And the reason the payload is copied onto the row instead of read back
    // from the outbox, whose purge runs on a much shorter horizon.
    expect(REPLAY_WINDOW_DAYS).toBe(30);
  });
});

describe("the lease, with the per-endpoint lane", () => {
  it("still covers one endpoint's whole share at its reduced concurrency", () => {
    // 10 rows of one endpoint, 2 at a time, 10 s each, behind the call of a
    // claim before (the continuous pool, F3-07): 60 s, inside 120 s.
    expect(() => assertWebhookLeaseInvariant(20)).not.toThrow();

    // One call at a time per endpoint, the lowest the variable takes:
    // 10 rounds plus the one before, 110 s, still inside.
    expect(() =>
      assertWebhookLeaseInvariant(20, 5, 10_000, 120, 10, 1),
    ).not.toThrow();

    // A lane so narrow it cannot finish its share within the lease is refused.
    expect(() =>
      assertWebhookLeaseInvariant(20, 5, 10_000, 120, 20, 1),
    ).toThrow(/lease invariant/);
  });
});

/**
 * The global cap per endpoint (plano-escala F3-13): what one capped claim
 * may take of an endpoint, whatever the other dispatchers hold.
 */
describe("an endpoint's share of a capped claim", () => {
  it("is what the global cap leaves after the rows in flight in every process", () => {
    expect(endpointShare(0, 4, 2)).toBe(2);
    expect(endpointShare(3, 4, 2)).toBe(1);
    expect(endpointShare(4, 4, 2)).toBe(0);
  });

  it("is never negative, even past the cap (an older image's claim)", () => {
    expect(endpointShare(6, 4, 2)).toBe(0);
  });

  it("never claims past what this process may send to the endpoint at once", () => {
    // A row claimed past the process's own cap would wait in its pool,
    // holding a unit of the cap the other dispatchers could send with.
    expect(endpointShare(0, 16, 2)).toBe(2);
    expect(endpointShare(0, 16, 32, 10)).toBe(10);
  });

  it("starts at what production's two api replicas already send to one endpoint", () => {
    // Two replicas at 2 calls each: nothing changes until a dispatcher is
    // added (decision D8).
    expect(WEBHOOK_ENDPOINT_GLOBAL_CONCURRENCY).toBe(
      2 * WEBHOOK_PER_ENDPOINT_CONCURRENCY,
    );
  });
});

/**
 * The host the cap per destination host groups endpoints by (plano-escala
 * F3-14): one server however its URL is spelled.
 */
describe("an endpoint's destination host", () => {
  it("is the URL's host, lower case, without port, user, path or trailing dot", () => {
    expect(destinationHostOf("https://Api.Example.com/hook")).toBe(
      "api.example.com",
    );
    expect(
      destinationHostOf("https://user:senha@api.example.com:8443/x?y=1#z"),
    ).toBe("api.example.com");
    expect(destinationHostOf("https://api.example.com./hook")).toBe(
      "api.example.com",
    );
  });

  it("keeps an IPv6 literal in brackets, as the backfill does", () => {
    expect(destinationHostOf("https://[2001:db8::1]:443/h")).toBe(
      "[2001:db8::1]",
    );
  });

  it("is none for a URL that does not parse: no group, no host cap", () => {
    expect(destinationHostOf("não é uma url")).toBeNull();
    expect(destinationHostOf("")).toBeNull();
  });
});
