import { describe, expect, it } from "vitest";

import {
  collectAlerts,
  evaluateAlerts,
  type OperationalSnapshot,
} from "@/shared/health/alert-rules";
import {
  clusterEpochStaleReason,
  type ClusterEpochState,
} from "@/shared/health/cluster-epoch";

/**
 * Plano-escala U-14: after a PITR or a failover the transaction ids are
 * handed out again, and the integration feed's cursor tells the histories
 * apart by the cluster's epoch. The release step bumps the epoch when the
 * cluster's system_identifier or timeline changes; between the event and
 * that step the epoch is stale, and the ops heartbeat says so every minute.
 */
const NOW = new Date("2026-11-17T15:00:00Z");
const SYSTEM = "7309281734651223042";

function snapshot(clusterEpoch?: ClusterEpochState): OperationalSnapshot {
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
    ...(clusterEpoch && { clusterEpoch }),
    collectionErrors: [],
  };
}

const state = (
  stored: ClusterEpochState["stored"],
  current: ClusterEpochState["current"] = {
    systemIdentifier: SYSTEM,
    timeline: 1,
  },
): ClusterEpochState => ({ stored, current });

const codes = (value: OperationalSnapshot) =>
  collectAlerts(value).map((alert) => alert.code);

describe("the cluster epoch alert", () => {
  it("stays quiet while the row describes the cluster", () => {
    expect(
      codes(
        snapshot(state({ epoch: 3, systemIdentifier: SYSTEM, timeline: 1 })),
      ),
    ).toEqual([]);
  });

  it("pages after a PITR or a promote: the timeline moved", () => {
    const reasons = evaluateAlerts(
      snapshot(
        state(
          { epoch: 3, systemIdentifier: SYSTEM, timeline: 1 },
          { systemIdentifier: SYSTEM, timeline: 2 },
        ),
      ),
    );

    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain("época 3");
    expect(reasons[0]).toContain("timeline 1 → 2");
    expect(reasons[0]).toContain("trajetto-api-migrate");
    expect(reasons[0]).toMatch(
      /\(runbook: docs\/runbooks\/cluster-epoch-stale\.md\)$/,
    );
  });

  it("pages on a new cluster: the system identifier moved", () => {
    const reason = clusterEpochStaleReason(
      state(
        { epoch: 1, systemIdentifier: SYSTEM, timeline: 1 },
        { systemIdentifier: "7309281734651223099", timeline: 1 },
      ),
    );

    expect(reason).toContain(`system_identifier ${SYSTEM} → `);
    expect(reason).not.toContain("timeline");
  });

  it("names both changes when both moved", () => {
    const reason = clusterEpochStaleReason(
      state(
        { epoch: 1, systemIdentifier: SYSTEM, timeline: 1 },
        { systemIdentifier: "1", timeline: 4 },
      ),
    );

    expect(reason).toContain("system_identifier");
    expect(reason).toContain("timeline 1 → 4");
  });

  it("pages when the release step never wrote the row", () => {
    expect(codes(snapshot(state(null)))).toEqual(["cluster-epoch-stale"]);
    expect(clusterEpochStaleReason(state(null))).toMatch(/sem linha/);
  });

  it("judges nothing without a reading", () => {
    expect(codes(snapshot())).toEqual([]);
  });
});
