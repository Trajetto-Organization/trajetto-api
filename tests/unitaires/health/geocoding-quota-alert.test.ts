import { describe, expect, it } from "vitest";

import {
  DEFAULT_ALERT_THRESHOLDS,
  collectAlerts,
  evaluateAlerts,
  type OperationalSnapshot,
} from "@/shared/health/alert-rules";

/**
 * Plano-escala F2-32 (decision D40): the geocoder's day against the plan
 * the owner wrote down (LOCATIONIQ_DAILY_QUOTA). Past 70% of it the ops
 * heartbeat pages, while the rest of the day still leaves time to raise
 * the plan or lower a budget before the provider's 429 holds every path
 * until midnight UTC. Without a quota written, nothing is judged.
 */
const NOW = new Date("2026-11-16T15:00:00Z");

function snapshot(
  geocodingQuota?: OperationalSnapshot["geocodingQuota"],
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
    ...(geocodingQuota && { geocodingQuota }),
    collectionErrors: [],
  };
}

const codes = (value: OperationalSnapshot) =>
  collectAlerts(value).map((alert) => alert.code);

describe("the geocoding quota alert", () => {
  it("pages past 70% of the plan's day, naming the variable and the runbook", () => {
    const reasons = evaluateAlerts(
      snapshot({ usedToday: 17_501, dailyQuota: 25_000 }),
    );

    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/LOCATIONIQ_DAILY_QUOTA/);
    expect(reasons[0]).toMatch(/70%/);
    expect(reasons[0]).toMatch(
      /\(runbook: docs\/runbooks\/geocoding-quota-high\.md\)$/,
    );
  });

  it("stays quiet at 70% exactly, and below", () => {
    expect(codes(snapshot({ usedToday: 17_500, dailyQuota: 25_000 }))).toEqual(
      [],
    );
    expect(codes(snapshot({ usedToday: 10, dailyQuota: 25_000 }))).toEqual([]);
  });

  it("judges nothing without a quota written down or a reading", () => {
    expect(codes(snapshot())).toEqual([]);
    expect(DEFAULT_ALERT_THRESHOLDS.geocodingQuotaRatio).toBe(0.7);
  });
});
