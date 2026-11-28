import { describe, expect, it } from "vitest";

import {
  collectAlerts,
  evaluateAlerts,
  type OperationalSnapshot,
} from "@/shared/health/alert-rules";
import { feedTxidRegressed, resetwalEpochFor } from "@/shared/health/feed-txid";

/**
 * Plano-escala F2-03: delivery_event.txid is the commit-order stamp of the
 * integration feed. After a logical restore into a NEW cluster the stored
 * stamps come from the old cluster's counter while the new one starts near
 * zero, so every event written afterwards sorts behind the integrators'
 * cursors and is never served — silently. The ops heartbeat pages when the
 * largest stored stamp is not below the next xid the cluster hands out, and
 * the runbook says which epoch `pg_resetwal -e` needs.
 */
const NOW = new Date("2026-11-17T15:00:00Z");

function snapshot(
  feedTxid?: OperationalSnapshot["feedTxid"],
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
    ...(feedTxid && { feedTxid }),
    collectionErrors: [],
  };
}

const codes = (value: OperationalSnapshot) =>
  collectAlerts(value).map((alert) => alert.code);

describe("the feed txid regression alert", () => {
  it("pages when a stored stamp is ahead of the cluster, with both numbers and the runbook", () => {
    const reasons = evaluateAlerts(
      snapshot({ newest: 48_000_000n, next: 912n }),
    );

    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain("48000000");
    expect(reasons[0]).toContain("912");
    expect(reasons[0]).toMatch(/pg_resetwal -e/);
    expect(reasons[0]).toMatch(
      /\(runbook: docs\/runbooks\/feed-txid-regressed\.md\)$/,
    );
  });

  it("pages at the next xid itself: no committed transaction has it yet", () => {
    expect(codes(snapshot({ newest: 912n, next: 912n }))).toEqual([
      "feed-txid-regressed",
    ]);
  });

  it("stays quiet below the next xid, which is every healthy reading", () => {
    expect(codes(snapshot({ newest: 911n, next: 912n }))).toEqual([]);
  });

  it("judges nothing without a stamped event, or without a reading", () => {
    expect(codes(snapshot({ newest: null, next: 912n }))).toEqual([]);
    expect(codes(snapshot())).toEqual([]);
  });

  it("compares 64-bit stamps past the precision of a number", () => {
    // Epoch 2: past 2^53 nothing is lost, the comparison is on bigints.
    const next = (2n << 32n) + 10n;

    expect(feedTxidRegressed({ newest: next - 1n, next })).toBe(false);
    expect(feedTxidRegressed({ newest: next, next })).toBe(true);
    expect(
      feedTxidRegressed({ newest: 9_007_199_254_740_993n, next: 2n ** 53n }),
    ).toBe(true);
  });
});

describe("the epoch pg_resetwal -e needs", () => {
  it("is the one after the newest stamp's, so every new xid lands above it", () => {
    expect(resetwalEpochFor(48_000_000n)).toBe(1n);
    expect(resetwalEpochFor((1n << 32n) - 1n)).toBe(1n);
    expect(resetwalEpochFor(1n << 32n)).toBe(2n);
    expect(resetwalEpochFor((5n << 32n) + 7n)).toBe(6n);

    // An xid8 is epoch × 2^32 + xid: the smallest id of that epoch is
    // already past the newest stamp.
    const newest = (5n << 32n) + 7n;

    expect(resetwalEpochFor(newest) << 32n).toBeGreaterThan(newest);
  });
});
