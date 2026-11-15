import { describe, expect, it, vi } from "vitest";

import {
  snapshotQueryStatsHandler,
  snapshotQueryStatsJob,
  type SnapshotOutcome,
} from "@/jobs/cron/snapshot-query-stats-job";

/**
 * The hourly pg_stat_statements snapshot (plano-escala F1-12) is elected
 * like every cron and runs at :13. Production runs without the preloaded
 * library until the new Postgres image (wave 3): there the state is
 * "not_loaded", and the run must be a no-op with a warning, never a FAILED
 * job that pages as "Cron sem execução bem-sucedida" for a measurement that
 * is simply not there yet. A database that does not answer is a failure.
 */
const OUTCOME: SnapshotOutcome = {
  written: 2,
  active: 2,
  statements: 10,
  recreated: 0,
  vanished: 0,
  evicted: 0,
  reset: false,
};

describe("the query stats snapshot job", () => {
  it("runs hourly at :13", () => {
    expect(snapshotQueryStatsJob.name).toBe("snapshot-query-stats");
    expect(snapshotQueryStatsJob.schedule).toBe("13 * * * *");
  });

  it.each(["not_loaded", "missing"] as const)(
    "does nothing, and succeeds, while the state is %s",
    async (state) => {
      const snapshot = vi.fn(async () => OUTCOME);

      await expect(
        snapshotQueryStatsHandler({ readState: async () => state, snapshot })(),
      ).resolves.toBeUndefined();

      expect(snapshot).not.toHaveBeenCalled();
    },
  );

  it("takes the snapshot at the elected minute once the view is ready", async () => {
    const snapshot = vi.fn(async (_input: { takenAt: Date }) => OUTCOME);
    const slot = new Date("2026-11-15T14:13:00.000Z");

    await snapshotQueryStatsHandler({
      readState: async () => "ready",
      snapshot,
    })({ scheduledFor: slot });

    expect(snapshot).toHaveBeenCalledWith({ takenAt: slot });
  });

  it("fails the run when the database does not answer", async () => {
    const snapshot = vi.fn(async () => OUTCOME);

    await expect(
      snapshotQueryStatsHandler({
        readState: async () => {
          throw new Error("ECONNREFUSED");
        },
        snapshot,
      })(),
    ).rejects.toThrow("ECONNREFUSED");
    expect(snapshot).not.toHaveBeenCalled();
  });
});
