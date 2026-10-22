import { describe, expect, it } from "vitest";

import {
  evaluateAlerts,
  type OperationalSnapshot,
} from "@/shared/health/alert-rules";

/**
 * The AI pipeline paused by the provider pages the operation (AI-8).
 *
 * The spend limit used to end every request FAILED, which the credential
 * rule did not recognise; now the requests wait, and waiting quietly would
 * be worse. The snapshot counts the due requests put back with the pause
 * marker, and any of them is a reason.
 */
function snapshot(paused: number | undefined): OperationalSnapshot {
  return {
    now: new Date("2026-09-29T12:00:00Z"),
    outboxEligibleLagSec: null,
    deliveryEligibleLagSec: { internal: null, external: null },
    webhookDueLagSec: null,
    aiEligibleLagSec: 30,
    deliveryFailures: [],
    aiCredentialFailures: 0,
    aiProviderPausedRequests: paused,
    cronJobs: [],
    partitionRunwayOk: true,
    partitionRunwayDays: 7,
    stuckWorkers: [],
    connectionUsagePercent: 10,
    redisOk: true,
    collectionErrors: [],
  };
}

describe("an AI queue paused by the provider", () => {
  it("is a reason to wake someone, before the lag rule would", () => {
    const reasons = evaluateAlerts(snapshot(3));

    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain("Análises de IA pausadas: 3");
  });

  it("says nothing while no request is paused", () => {
    expect(evaluateAlerts(snapshot(0))).toEqual([]);
    expect(evaluateAlerts(snapshot(undefined))).toEqual([]);
  });
});
