import { describe, expect, it } from "vitest";

import {
  collectAlerts,
  evaluateAlerts,
  type OperationalSnapshot,
} from "@/shared/health/alert-rules";

/**
 * Plano-escala F3-22 (and F3-34's third rule): a durable job of
 * background_job that is due and that nobody claimed for ten minutes pages
 * as job-overdue — the worker's sweep is 2 s, the role all's 30 s, and a
 * dead process's lease runs out within 2 min, so ten minutes is a queue
 * nobody runs or a kind no process can run. With a fleet read, a due job
 * and no live process claiming `jobs` is also the queue-no-consumer of the
 * other queues. A snapshot that did not read the table judges nothing.
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

const fleet = (queues: string[]): OperationalSnapshot["processes"] => ({
  appEnv: "staging",
  live: [
    {
      replica: "api-1",
      role: "api",
      appEnv: "staging",
      commit: "abc",
      queues,
      startedAt: new Date(NOW.getTime() - 60_000),
    },
  ],
});

describe("the job-overdue alert", () => {
  it("pages for a job due and unclaimed for more than ten minutes, with its runbook", () => {
    const reasons = evaluateAlerts(snapshot({ jobEligibleLagSec: 601 }));

    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/^Jobs duráveis/);
    expect(reasons[0]).toMatch(/\(runbook: docs\/runbooks\/job-overdue\.md\)$/);
  });

  it("stays quiet up to ten minutes, with nothing due, and without a reading", () => {
    expect(codes(snapshot({ jobEligibleLagSec: 600 }))).toEqual([]);
    expect(codes(snapshot({ jobEligibleLagSec: null }))).toEqual([]);
    expect(codes(snapshot())).toEqual([]);
  });

  it("names the jobs queue when no live process claims it", () => {
    const alerts = collectAlerts(
      snapshot({ jobEligibleLagSec: 180, processes: fleet(["outbox"]) }),
    );

    expect(alerts.map((alert) => alert.code)).toEqual(["queue-no-consumer"]);
    expect(alerts[0].message).toMatch(/fila jobs/);
  });

  it("does not count the jobs queue without a reading, nor with a consumer", () => {
    expect(codes(snapshot({ processes: fleet([]) }))).toEqual([]);
    expect(
      codes(snapshot({ jobEligibleLagSec: 180, processes: fleet(["jobs"]) })),
    ).toEqual([]);
  });
});
