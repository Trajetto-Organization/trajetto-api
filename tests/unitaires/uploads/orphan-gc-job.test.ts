import { afterEach, describe, expect, it, vi } from "vitest";

import { clearLogged, logged } from "../../support/log-capture";

vi.mock("@/shared/logging/logger", async (importOriginal) =>
  (await import("../../support/log-capture")).capturingLogger(
    await importOriginal(),
  ),
);

/**
 * How the nightly orphan job reports a run whose scopes failed.
 *
 * The collector skips a scope whose listing or lookup fails and carries on,
 * so one storage hiccup does not cost the night's summary. But when NOT ONE
 * scope could be read — credentials without List permission, the database
 * down — that is the job failing, and the scheduler must record it as a
 * failed run instead of a quiet night with nothing to collect.
 */
const run = vi.hoisted(() => vi.fn());

vi.mock("@/shared/services/orphan-uploads", () => ({
  runOrphanUploadGc: run,
}));

const summary = (overrides: Record<string, unknown>) => ({
  mode: "dry-run",
  scopes: 0,
  scanned: 0,
  referenced: 0,
  orphaned: 0,
  deleted: 0,
  locked: 0,
  failed: 0,
  errors: 0,
  stoppedEarly: false,
  sample: [],
  ...overrides,
});

afterEach(() => {
  run.mockReset();
  clearLogged();
  vi.restoreAllMocks();
});

describe("the cleanup-orphan-uploads job", () => {
  it("fails the run when no scope could be read at all", async () => {
    run.mockResolvedValue(summary({ scopes: 0, errors: 12 }));

    const { cleanupOrphanUploadsJob } =
      await import("@/jobs/cron/cleanup-orphan-uploads-job");

    await expect(cleanupOrphanUploadsJob.handler()).rejects.toThrow(
      /Nenhum escopo/,
    );
  });

  it("completes, with a warning, when only some scopes failed", async () => {
    run.mockResolvedValue(summary({ scopes: 40, errors: 1 }));

    const { cleanupOrphanUploadsJob } =
      await import("@/jobs/cron/cleanup-orphan-uploads-job");

    await expect(cleanupOrphanUploadsJob.handler()).resolves.toBeUndefined();

    const warned = logged("warn");

    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatchObject({
      job: "cleanup-orphan-uploads",
      skippedScopes: 1,
    });
  });

  it("succeeds with the count when a Bucket Lock held some orphans", async () => {
    // plano-escala F1-23: a lock is policy, not a fault. The run ends
    // SUCCEEDED, the count goes in its own line, and the line an alert keys
    // on ("could not be deleted") stays silent.
    run.mockResolvedValue(
      summary({
        mode: "delete",
        scopes: 12,
        orphaned: 5,
        deleted: 3,
        locked: 2,
      }),
    );

    const { cleanupOrphanUploadsJob } =
      await import("@/jobs/cron/cleanup-orphan-uploads-job");

    await expect(cleanupOrphanUploadsJob.handler()).resolves.toBeUndefined();

    const warned = logged("warn");

    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatchObject({
      job: "cleanup-orphan-uploads",
      locked: 2,
      msg: "orphan uploads held by a bucket lock were skipped",
    });
    expect(logged("info")).toContainEqual(
      expect.objectContaining({
        summary: expect.objectContaining({ locked: 2, failed: 0 }),
      }),
    );
  });

  it("does nothing when switched off", async () => {
    run.mockResolvedValue(null);

    const { cleanupOrphanUploadsJob } =
      await import("@/jobs/cron/cleanup-orphan-uploads-job");

    await expect(cleanupOrphanUploadsJob.handler()).resolves.toBeUndefined();
  });
});
