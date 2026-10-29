import { describe, expect, it } from "vitest";

import {
  COOLDOWNS,
  DOWN_AFTER_CONSECUTIVE_FAILURES,
  ProviderCircuit,
} from "@/shared/ai/provider-circuit";
import { classifyProviderFailure } from "@/shared/ai/provider-failure";

/**
 * What a provider's refusal means for the pipeline (AI-8).
 *
 * Before: the account's spend limit (429, no retry-after) was a rate limit,
 * so each request burnt its four attempts in ~12 minutes and ended FAILED;
 * the organisation's own usage limit (400) was "malformed request", so the
 * whole queue failed at once.
 */
describe("a provider failure", () => {
  it("is quota_exhausted on the spend limit, whatever the status", () => {
    expect(
      classifyProviderFailure({
        status: 429,
        errorType: "rate_limit_error",
        errorCode: "enforced_spend_limit_reached",
        message: "rate limited",
      }),
    ).toBe("quota_exhausted");
  });

  it("is quota_exhausted on the organisation's own usage limit and on billing", () => {
    expect(
      classifyProviderFailure({
        status: 400,
        errorType: "invalid_request_error",
        message: "You have reached your specified API usage limits.",
      }),
    ).toBe("quota_exhausted");

    expect(
      classifyProviderFailure({
        status: 402,
        errorType: "billing_error",
        message: "",
      }),
    ).toBe("quota_exhausted");
  });

  it("is retryable on a plain rate limit, a server error, an overload and the network", () => {
    for (const status of [429, 500, 503, 529, 408, undefined]) {
      expect(
        classifyProviderFailure({ status, message: "x" }),
        String(status),
      ).toBe("retryable");
    }
  });

  it("is unauthorized on a refused key and permanent on a request that will never work", () => {
    expect(classifyProviderFailure({ status: 401, message: "" })).toBe(
      "unauthorized",
    );
    expect(classifyProviderFailure({ status: 403, message: "" })).toBe(
      "unauthorized",
    );
    expect(classifyProviderFailure({ status: 400, message: "bad image" })).toBe(
      "permanent",
    );
    expect(classifyProviderFailure({ status: 413, message: "" })).toBe(
      "permanent",
    );
  });
});

describe("the provider circuit", () => {
  const at = (ms: number) => new Date(Date.UTC(2026, 8, 29, 12, 0, 0) + ms);

  it("lets every slot claim while closed", () => {
    expect(new ProviderCircuit().claimable(4, at(0))).toBe(4);
  });

  it("opens on the spend limit at once, and lets one probe through after the cooldown", () => {
    const circuit = new ProviderCircuit();

    circuit.recordFailure("quota_exhausted", at(0));

    expect(circuit.claimable(4, at(1_000))).toBe(0);
    expect(circuit.snapshot(at(1_000))).toMatchObject({
      state: "open",
      reason: "quota_exhausted",
    });

    const after = COOLDOWNS.quota_exhausted.firstMs;

    expect(circuit.claimable(4, at(after))).toBe(1);

    // One probe at a time.
    circuit.markProbeStarted();
    expect(circuit.claimable(4, at(after))).toBe(0);

    // The probe answers: closed again, every slot back.
    circuit.recordSuccess();
    expect(circuit.claimable(4, at(after + 1))).toBe(4);
  });

  it("opens for longer each time the same trouble comes back", () => {
    const circuit = new ProviderCircuit();

    circuit.recordFailure("quota_exhausted", at(0));
    const first = circuit.snapshot().retryAt!.getTime() - at(0).getTime();

    circuit.markProbeStarted();
    circuit.recordFailure("quota_exhausted", at(first));
    const second = circuit.snapshot().retryAt!.getTime() - at(first).getTime();

    expect(second).toBe(first * 2);
  });

  it("counts transient failures in a row before calling the provider down", () => {
    const circuit = new ProviderCircuit();

    for (let n = 1; n < DOWN_AFTER_CONSECUTIVE_FAILURES; n += 1) {
      circuit.recordFailure("retryable", at(n));
    }

    expect(circuit.snapshot(at(10)).state).toBe("closed");

    // An answer from the provider, even a refusal of the request, means it
    // is up: the streak starts over.
    circuit.recordFailure("permanent", at(11));
    circuit.recordFailure("retryable", at(12));
    expect(circuit.snapshot(at(13)).state).toBe("closed");

    for (let n = 0; n < DOWN_AFTER_CONSECUTIVE_FAILURES; n += 1) {
      circuit.recordFailure("retryable", at(20 + n));
    }

    expect(circuit.snapshot(at(30))).toMatchObject({
      state: "open",
      reason: "provider_down",
    });
  });

  it("frees the probe slot when the probe ended without an answer", () => {
    const circuit = new ProviderCircuit();

    circuit.recordFailure("unauthorized", at(0));

    const after = COOLDOWNS.unauthorized.firstMs;
    expect(circuit.claimable(4, at(after))).toBe(1);

    circuit.markProbeStarted();
    circuit.releaseProbe();

    expect(circuit.claimable(4, at(after))).toBe(1);
  });
});

describe("a busy reader (ADR 0010 §3.2)", () => {
  const at = (ms: number) => new Date(Date.UTC(2026, 9, 5, 12, 0, 0) + ms);

  it("never opens the circuit, however many times in a row", () => {
    const circuit = new ProviderCircuit();

    for (let i = 0; i < DOWN_AFTER_CONSECUTIVE_FAILURES * 3; i++) {
      circuit.recordFailure("busy", at(i));
    }

    expect(circuit.snapshot(at(100)).state).toBe("closed");
    expect(circuit.claimable(4, at(100))).toBe(4);
  });

  it("breaks a streak of transient failures: the service answered", () => {
    const circuit = new ProviderCircuit();

    for (let i = 0; i < DOWN_AFTER_CONSECUTIVE_FAILURES - 1; i++) {
      circuit.recordFailure("retryable", at(i));
    }

    circuit.recordFailure("busy", at(10));
    circuit.recordFailure("retryable", at(11));

    // Without the reset, this fifth transient failure would open it.
    expect(circuit.snapshot(at(12)).state).toBe("closed");
  });

  it("closes a circuit opened by an outage when the probe meets a full queue", () => {
    const circuit = new ProviderCircuit();

    for (let i = 0; i < DOWN_AFTER_CONSECUTIVE_FAILURES; i++) {
      circuit.recordFailure("retryable", at(i));
    }

    expect(circuit.snapshot(at(10)).reason).toBe("provider_down");

    circuit.markProbeStarted();
    circuit.recordFailure("busy", at(COOLDOWNS.provider_down.firstMs + 10));

    expect(
      circuit.snapshot(at(COOLDOWNS.provider_down.firstMs + 11)).state,
    ).toBe("closed");
  });
});
