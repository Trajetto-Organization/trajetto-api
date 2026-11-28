import { describe, expect, it } from "vitest";

import {
  collectAlerts,
  evaluateAlerts,
  type OperationalSnapshot,
} from "@/shared/health/alert-rules";

/**
 * Plano-escala F3-26a and F3-27: a company's purge (TENANT_OFFBOARD) or a
 * person's anonymization (USER_ANONYMIZE) that keeps failing leaves the
 * data half gone — the company PURGING with no way back, the person with
 * `anonymized_at` and asking again refused — and only a log line said so.
 * Past its attempts the runner retries it every hour; job-failing pages
 * while it keeps failing, and for 24 h after one failed for good. A
 * snapshot that did not read the table judges nothing.
 */
const NOW = new Date("2026-11-19T12:00:00Z");

function snapshot(
  extra: Partial<OperationalSnapshot> = {},
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
    collectionErrors: [],
    ...extra,
  };
}

const codes = (value: OperationalSnapshot) =>
  collectAlerts(value).map((alert) => alert.code);

describe("the job-failing alert", () => {
  it("pages for a job that must finish and keeps failing, with its runbook", () => {
    const reasons = evaluateAlerts(
      snapshot({ mustFinishJobs: { failing: 1, failed: 0 } }),
    );

    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/1 seguem falhando/);
    expect(reasons[0]).toMatch(/\(runbook: docs\/runbooks\/job-failing\.md\)$/);
  });

  it("pages for one that failed for good", () => {
    expect(
      codes(snapshot({ mustFinishJobs: { failing: 0, failed: 2 } })),
    ).toEqual(["job-failing"]);
  });

  it("stays quiet with none, or when the table was not read", () => {
    expect(
      codes(snapshot({ mustFinishJobs: { failing: 0, failed: 0 } })),
    ).toEqual([]);
    expect(codes(snapshot())).toEqual([]);
  });
});
