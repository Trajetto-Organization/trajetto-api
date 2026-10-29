import { describe, expect, it } from "vitest";

import {
  PROVIDER_CHANNELS,
  createProviderMetrics,
  httpOutcome,
  observeProviderCall,
  providerErrorKind,
} from "@/shared/health/provider-metrics";

/**
 * Provider latency and error rate per channel (contract §32). A retry that
 * eventually succeeds hides a slow or failing provider from the delivery
 * tables; these numbers are the only place "Meta answers in 8 s" shows.
 */
describe("the provider metrics window", () => {
  it("emits every channel, zero-filled, with an unknown rate when nothing was called", () => {
    const metrics = createProviderMetrics();
    const snapshot = metrics.snapshot();

    expect(snapshot.channels.map((c) => c.channel)).toEqual([
      ...PROVIDER_CHANNELS,
    ]);

    for (const channel of snapshot.channels) {
      expect(channel.calls).toBe(0);
      expect(channel.error_rate).toBeNull();
      expect(channel.latency_p95_ms).toBeNull();
    }
  });

  it("computes the error rate and the percentiles of the window", () => {
    const metrics = createProviderMetrics();

    for (let i = 1; i <= 20; i += 1)
      metrics.record("WHATSAPP", i * 10, i % 4 !== 0, "http_500");

    const whatsapp = metrics
      .snapshot()
      .channels.find((c) => c.channel === "WHATSAPP")!;

    expect(whatsapp.calls).toBe(20);
    expect(whatsapp.errors).toBe(5);
    expect(whatsapp.error_rate).toBe(0.25);
    expect(whatsapp.latency_p50_ms).toBe(100);
    expect(whatsapp.latency_p95_ms).toBe(190);
    expect(whatsapp.latency_max_ms).toBe(200);
    expect(whatsapp.last_error_kind).toBe("http_500");
  });

  it("forgets calls older than the window but keeps the totals", () => {
    let clock = 0;
    const metrics = createProviderMetrics({
      windowMs: 60_000,
      now: () => clock,
    });

    metrics.record("EMAIL", 50, false, "eauth");
    clock = 120_000;
    metrics.record("EMAIL", 70, true);

    const email = metrics
      .snapshot()
      .channels.find((c) => c.channel === "EMAIL")!;

    expect(email.calls).toBe(1);
    expect(email.errors).toBe(0);
    expect(email.error_rate).toBe(0);
    expect(email.total_calls).toBe(2);
    expect(email.total_errors).toBe(1);
    expect(email.last_error_kind).toBe("eauth");
  });

  it("never grows past its capacity", () => {
    const metrics = createProviderMetrics({ capacity: 10 });

    for (let i = 0; i < 100; i += 1) metrics.record("PUSH", 5, true);

    const push = metrics.snapshot().channels.find((c) => c.channel === "PUSH")!;

    expect(push.calls).toBe(10);
    expect(push.total_calls).toBe(100);
  });
});

describe("observing a provider call", () => {
  it("records a non-ok response as an error with its status, and returns it", async () => {
    const metrics = createProviderMetrics();

    const response = await observeProviderCall(
      "PUSH",
      async () => ({ ok: false, status: 401 }),
      httpOutcome,
      metrics,
    );

    expect(response.status).toBe(401);

    const push = metrics.snapshot().channels.find((c) => c.channel === "PUSH")!;

    expect(push.errors).toBe(1);
    expect(push.last_error_kind).toBe("http_401");
  });

  it("records a throw and rethrows it untouched", async () => {
    const metrics = createProviderMetrics();
    const failure = Object.assign(
      new Error("Invalid login: 535 for user@x.com"),
      {
        code: "EAUTH",
        responseCode: 535,
      },
    );

    await expect(
      observeProviderCall(
        "EMAIL",
        async () => Promise.reject(failure),
        undefined,
        metrics,
      ),
    ).rejects.toBe(failure);

    const email = metrics
      .snapshot()
      .channels.find((c) => c.channel === "EMAIL")!;

    expect(email.errors).toBe(1);
    // The kind, never the message with the address.
    expect(email.last_error_kind).toBe("smtp_535");
    expect(JSON.stringify(metrics.snapshot())).not.toContain("user@x.com");
  });
});

describe("the error kind", () => {
  it.each([
    [Object.assign(new Error("x"), { name: "TimeoutError" }), "timeout"],
    [Object.assign(new Error("x"), { httpStatus: 403 }), "http_403"],
    [Object.assign(new Error("x"), { code: "ECONNREFUSED" }), "econnrefused"],
    [
      Object.assign(new Error("x"), { cause: { code: "ENOTFOUND" } }),
      "enotfound",
    ],
    [
      Object.assign(new Error("x"), { code: "has spaces and a token abc" }),
      "error",
    ],
    ["a string", "error"],
  ])("names %s as %s", (error, kind) => {
    expect(providerErrorKind(error)).toBe(kind);
  });
});
