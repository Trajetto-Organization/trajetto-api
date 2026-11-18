import { describe, expect, it } from "vitest";

import { env } from "@/env";
import { syncWatermark } from "@/modules/integration/usecases/integration-read/integration-read-controller";
import {
  collectAlerts,
  evaluateAlerts,
  type OperationalSnapshot,
} from "@/shared/health/alert-rules";
import {
  countFeedConversion,
  takeFeedCounts,
} from "@/shared/integration/feed-metrics";

/**
 * What the commit-order feed (plano-escala F2-05) tells the operation and
 * the integrator beside the events.
 *
 *  - Each process counts its cursor conversions per minute, into the
 *    `feed` section of its ops_sample row, and the section resets when the
 *    sampler reads it: a count that never reset would page forever.
 *  - A conversion of a cursor of another cluster epoch pages
 *    feed-epoch-conversion: the events since its floor went out again, and
 *    the customers should hear it from us. A legacy conversion does not:
 *    it is every integrator's first poll after the switch.
 *  - sync_watermark is the read's start minus SYNC_WATERMARK_MARGIN_MS.
 */
const NOW = new Date("2026-11-18T12:00:00Z");

function snapshot(feedEpochConversions?: number): OperationalSnapshot {
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
    ...(feedEpochConversions !== undefined && { feedEpochConversions }),
    collectionErrors: [],
  };
}

describe("the feed's counts", () => {
  it("count each kind of conversion and reset when read", () => {
    takeFeedCounts();

    countFeedConversion("epoch");
    countFeedConversion("legacy");
    countFeedConversion("legacy");

    expect(takeFeedCounts()).toEqual({
      epoch_conversions: 1,
      legacy_conversions: 2,
    });
    expect(takeFeedCounts()).toEqual({
      epoch_conversions: 0,
      legacy_conversions: 0,
    });
  });
});

describe("the feed-epoch-conversion alert", () => {
  it("stays quiet without conversions, or without the reading", () => {
    expect(collectAlerts(snapshot(0))).toEqual([]);
    expect(collectAlerts(snapshot())).toEqual([]);
  });

  it("pages after a conversion of another epoch, with its runbook", () => {
    const reasons = evaluateAlerts(snapshot(3));

    expect(collectAlerts(snapshot(3)).map((alert) => alert.code)).toEqual([
      "feed-epoch-conversion",
    ]);
    expect(reasons[0]).toContain("3 cursor(es)");
    expect(reasons[0]).toMatch(
      /\(runbook: docs\/runbooks\/feed-epoch-conversion\.md\)$/,
    );
  });
});

describe("sync_watermark", () => {
  it("is the read's start minus the margin, as ISO 8601", () => {
    expect(env.SYNC_WATERMARK_MARGIN_MS).toBe(120_000);
    expect(syncWatermark(NOW.getTime())).toBe("2026-11-18T11:58:00.000Z");
  });
});
