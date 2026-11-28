import { describe, expect, it } from "vitest";

import {
  collectAlerts,
  evaluateAlerts,
  type OperationalSnapshot,
} from "@/shared/health/alert-rules";

/**
 * Plano-escala F3-15c (decision D45): the providers' rate buckets ship off,
 * and the trigger to turn one on is a provider refusing for rate — Meta's
 * 130429 (or a 429), Resend's refusal, Expo's 429 — once in the last 24 h.
 * One platform account serves every company: a contract broken at Meta
 * throttles all of them, so one refusal pages. A reading of none, or no
 * reading at all, judges nothing.
 */
const NOW = new Date("2026-11-18T15:00:00Z");

function snapshot(
  providerThrottled?: OperationalSnapshot["providerThrottled"],
): OperationalSnapshot {
  return {
    now: NOW,
    outboxEligibleLagSec: null,
    deliveryEligibleLagSec: { internal: null, external: null },
    webhookDueLagSec: null,
    aiEligibleLagSec: null,
    deliveryFailures: [],
    aiCredentialFailures: 0,
    cronJobs: [],
    partitionRunwayOk: true,
    partitionRunwayDays: 7,
    stuckWorkers: [],
    connectionUsagePercent: 10,
    redisOk: true,
    ...(providerThrottled && { providerThrottled }),
    collectionErrors: [],
  };
}

const codes = (value: OperationalSnapshot) =>
  collectAlerts(value).map((alert) => alert.code);

describe("the provider-throttled alert", () => {
  it("pages for one refusal in 24 h, naming the provider, its variable and the runbook", () => {
    const reasons = evaluateAlerts(
      snapshot({ whatsapp: 1, email: 0, push: 0 }),
    );

    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/130429/);
    expect(reasons[0]).toMatch(/WHATSAPP_SENDS_PER_SECOND/);
    expect(reasons[0]).not.toMatch(/EMAIL_REQUESTS_PER_SECOND/);
    expect(reasons[0]).toMatch(
      /\(runbook: docs\/runbooks\/provider-throttled\.md\)$/,
    );
  });

  it("names every provider that refused, in one alert", () => {
    const reasons = evaluateAlerts(
      snapshot({ whatsapp: 0, email: 3, push: 1_200 }),
    );

    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(
      /e-mail 3 \(Resend; EMAIL_REQUESTS_PER_SECOND\)/,
    );
    expect(reasons[0]).toMatch(/push 1\.200/);
  });

  it("judges nothing with no refusal, or no reading", () => {
    expect(codes(snapshot({ whatsapp: 0, email: 0, push: 0 }))).toEqual([]);
    expect(codes(snapshot())).toEqual([]);
  });
});
