import { describe, expect, it, vi } from "vitest";

import { JobRunner, type JobContext } from "@/shared/jobs/job-runner";
import { workerHeartbeat } from "@/shared/health/worker-heartbeat";
import { InMemoryBackgroundJobRepository } from "@/shared/jobs/in-memory/in-memory-background-job-repository";
import {
  JobLeaseLostError,
  JobStoppedError,
  PermanentJobError,
} from "@/shared/jobs/job-errors";

/**
 * The durable jobs' runner (plano-escala F3-22), over the twin of
 * background_job (same lease, fence and claim rules as the SQL; the
 * contract suite holds the two together). What it pins:
 *
 *  - a job runs and ends SUCCEEDED; a kind with no handler is never taken;
 *  - a failure is retried with backoff, the attempt spent, until
 *    maxAttempts, then FAILED with the kind's onFailed called once; a
 *    PermanentJobError fails at once; a job claimed past its last attempt
 *    (its process died during it) fails without running;
 *  - SIGTERM: the handler's signal aborts, its checkpoint throws, and the
 *    job goes back PENDING at once with the attempt NOT spent and its
 *    cursor kept;
 *  - a SIGKILL: the lease runs out, another process claims the job, the
 *    old process can no longer write (its checkpoint throws
 *    JobLeaseLostError and nothing it does commits), and the new one
 *    resumes from the cursor: every effect happens once;
 *  - the cap of jobs running per company leaves the company's second job
 *    for when the first ends.
 */
const OWNER = () => "test-runner";

function runnerOn(store: InMemoryBackgroundJobRepository, slots = 2) {
  return new JobRunner({
    store,
    slots,
    sweepIntervalMs: 60_000,
    owner: OWNER,
    renewEveryMs: 60_000,
  });
}

async function enqueue(
  store: InMemoryBackgroundJobRepository,
  overrides: Partial<Parameters<typeof store.enqueue>[0]> = {},
) {
  const { job } = await store.enqueue({
    kind: "SPREADSHEET_IMPORT",
    businessId: "company-a",
    payload: {},
    ...overrides,
  });

  return job.id;
}

function statusOf(store: InMemoryBackgroundJobRepository, id: string) {
  return store.jobs.find((job) => job.id === id)!;
}

describe("the job runner", () => {
  it("runs a job and ends it SUCCEEDED", async () => {
    const store = new InMemoryBackgroundJobRepository();
    const runner = runnerOn(store);
    const seen: unknown[] = [];

    runner.register("SPREADSHEET_IMPORT", {
      run: async (job) => {
        seen.push(job.payload);
      },
    });

    const id = await enqueue(store, { payload: { importId: "i-1" } });

    expect(await runner.processBatch()).toBe(1);
    expect(seen).toEqual([{ importId: "i-1" }]);
    expect(statusOf(store, id)).toMatchObject({
      status: "SUCCEEDED",
      attempts: 1,
      leaseExpiresAt: null,
    });
    expect(statusOf(store, id).finished_at).not.toBeNull();
  });

  it("never takes a kind it has no handler for", async () => {
    const store = new InMemoryBackgroundJobRepository();
    const runner = runnerOn(store);

    runner.register("SPREADSHEET_IMPORT", { run: async () => undefined });

    const id = await enqueue(store, {
      kind: "TENANT_OFFBOARD",
      subjectId: "company-a",
    });

    expect(await runner.processBatch()).toBe(0);
    expect(statusOf(store, id)).toMatchObject({
      status: "PENDING",
      attempts: 0,
    });
  });

  it("retries a failure with backoff until its attempts run out, then fails it once", async () => {
    const store = new InMemoryBackgroundJobRepository();
    const runner = runnerOn(store);
    const onFailed = vi.fn(async () => undefined);

    runner.register("SPREADSHEET_IMPORT", {
      run: async () => {
        throw new Error("database went away");
      },
      onFailed,
    });

    const id = await enqueue(store, { maxAttempts: 2 });

    await runner.processBatch();

    const first = statusOf(store, id);

    expect(first).toMatchObject({ status: "PENDING", attempts: 1 });
    expect(first.lastError).toMatch(/database went away/);
    // 30 s ± 20%.
    expect(first.availableAt.getTime() - Date.now()).toBeGreaterThan(20_000);
    expect(onFailed).not.toHaveBeenCalled();

    // The backoff elapses.
    first.availableAt = new Date(Date.now() - 1);
    await runner.processBatch();

    expect(statusOf(store, id)).toMatchObject({
      status: "FAILED",
      attempts: 2,
    });
    expect(onFailed).toHaveBeenCalledTimes(1);
    expect(onFailed.mock.calls[0]).toEqual([
      expect.objectContaining({ id, kind: "SPREADSHEET_IMPORT", attempts: 2 }),
      expect.any(Error),
    ]);
  });

  it("fails a PermanentJobError at once", async () => {
    const store = new InMemoryBackgroundJobRepository();
    const runner = runnerOn(store);
    const onFailed = vi.fn(async () => undefined);

    runner.register("SPREADSHEET_IMPORT", {
      run: async () => {
        throw new PermanentJobError("the file is gone");
      },
      onFailed,
    });

    const id = await enqueue(store);

    await runner.processBatch();

    expect(statusOf(store, id)).toMatchObject({
      status: "FAILED",
      attempts: 1,
    });
    expect(onFailed).toHaveBeenCalledTimes(1);
  });

  it("fails without running a job claimed past its last attempt", async () => {
    const store = new InMemoryBackgroundJobRepository();
    const runner = runnerOn(store);
    const run = vi.fn(async () => undefined);
    const onFailed = vi.fn(async () => undefined);

    runner.register("SPREADSHEET_IMPORT", { run, onFailed });

    const id = await enqueue(store, { maxAttempts: 1 });

    // Its last allowed attempt died with its process: PROCESSING, the
    // lease run out.
    Object.assign(statusOf(store, id), {
      status: "PROCESSING",
      attempts: 1,
      leaseExpiresAt: new Date(Date.now() - 1_000),
    });

    await runner.processBatch();

    expect(run).not.toHaveBeenCalled();
    expect(statusOf(store, id)).toMatchObject({
      status: "FAILED",
      attempts: 2,
    });
    expect(onFailed).toHaveBeenCalledTimes(1);
  });

  it("never gives up on a job that must finish: past its attempts it comes back each hour, from its cursor", async () => {
    // A company's purge that failed for good stayed PURGING, half deleted,
    // with no way for anybody to finish it.
    const store = new InMemoryBackgroundJobRepository();
    const runner = runnerOn(store);
    const onFailed = vi.fn(async () => undefined);
    const seen: unknown[] = [];
    let bucketDown = true;

    runner.register("TENANT_OFFBOARD", {
      run: async (job) => {
        seen.push(job.progress);

        if (!bucketDown) return;

        await job.checkpoint({ phase: "storage", page: 3 });
        throw new Error("bucket unavailable");
      },
      onFailed,
    });

    const id = await enqueue(store, {
      kind: "TENANT_OFFBOARD",
      subjectId: "company-a",
      maxAttempts: 1,
    });

    await runner.processBatch();

    const first = statusOf(store, id);

    expect(first).toMatchObject({
      status: "PENDING",
      attempts: 1,
      maxAttempts: 2,
      progress: { phase: "storage", page: 3 },
    });
    expect(first.lastError).toMatch(/bucket unavailable/);
    // An hour ± 20%.
    expect(first.availableAt.getTime() - Date.now()).toBeGreaterThan(
      45 * 60_000,
    );

    // Still down an hour later: once more.
    first.availableAt = new Date(Date.now() - 1);
    await runner.processBatch();

    expect(statusOf(store, id)).toMatchObject({
      status: "PENDING",
      attempts: 2,
      maxAttempts: 3,
    });

    // The bucket is back: the purge ends, from its cursor.
    bucketDown = false;
    statusOf(store, id).availableAt = new Date(Date.now() - 1);
    await runner.processBatch();

    expect(statusOf(store, id)).toMatchObject({
      status: "SUCCEEDED",
      attempts: 3,
    });
    expect(seen).toEqual([
      null,
      { phase: "storage", page: 3 },
      { phase: "storage", page: 3 },
    ]);
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("still fails a job that must finish on a PermanentJobError, or when its process died in its last attempt", async () => {
    const store = new InMemoryBackgroundJobRepository();
    const runner = runnerOn(store);
    const run = vi.fn(async () => {
      throw new PermanentJobError("USER_ANONYMIZE sem sujeito ou empresa");
    });

    runner.register("USER_ANONYMIZE", { run });

    const permanent = await enqueue(store, {
      kind: "USER_ANONYMIZE",
      subjectId: "user-1",
    });

    await runner.processBatch();

    expect(statusOf(store, permanent)).toMatchObject({ status: "FAILED" });

    // A job that kills its process never loops: dead in its last attempt,
    // it fails without running.
    const killer = await enqueue(store, {
      kind: "USER_ANONYMIZE",
      subjectId: "user-2",
      maxAttempts: 1,
    });

    Object.assign(statusOf(store, killer), {
      status: "PROCESSING",
      attempts: 1,
      leaseExpiresAt: new Date(Date.now() - 1_000),
    });
    run.mockClear();

    await runner.processBatch();

    expect(run).not.toHaveBeenCalled();
    expect(statusOf(store, killer)).toMatchObject({
      status: "FAILED",
      attempts: 2,
    });
  });

  it("hands a job back at SIGTERM without spending the attempt, its cursor kept", async () => {
    const store = new InMemoryBackgroundJobRepository();
    const runner = runnerOn(store);
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    let stoppedBy: unknown = null;

    runner.register("SPREADSHEET_IMPORT", {
      run: async (job) => {
        await job.checkpoint({ next: 5 });
        started();

        // Rows go on until the stop asks for the next checkpoint.
        await new Promise<void>((resolve) =>
          job.signal.addEventListener("abort", () => resolve()),
        );

        try {
          await job.checkpoint({ next: 9 });
        } catch (error) {
          stoppedBy = error;
          throw error;
        }
      },
    });

    const id = await enqueue(store);
    const cycle = runner.processBatch();

    await running;
    await runner.shutdown({ deadlineMs: 2_000 });
    await cycle;

    expect(stoppedBy).toBeInstanceOf(JobStoppedError);
    expect(statusOf(store, id)).toMatchObject({
      status: "PENDING",
      attempts: 0,
      progress: { next: 5 },
      leaseExpiresAt: null,
    });
  });

  it("resumes a job whose process died, from its cursor, every effect once", async () => {
    const store = new InMemoryBackgroundJobRepository();
    const effects: number[] = [];

    // The rows 0..5; each effect is written with the cursor past it, as
    // the handlers do inside one transaction (here: the effect is kept
    // only when the fenced checkpoint passed).
    const handler = (stopAfter: number | null) => ({
      run: async (job: JobContext) => {
        const start = (job.progress as { next: number } | null)?.next ?? 0;

        for (let row = start; row < 6; row += 1) {
          if (stopAfter !== null && row === stopAfter) {
            // The process is killed here: nothing more is written, and the
            // run never returns.
            await new Promise(() => undefined);
          }

          await job.checkpoint({ next: row + 1 });
          effects.push(row);
        }
      },
    });

    const dying = runnerOn(store);
    dying.register("SPREADSHEET_IMPORT", handler(3));

    const id = await enqueue(store);
    void dying.processBatch();

    await vi.waitFor(() => expect(effects).toEqual([0, 1, 2]));

    // Two minutes on: the lease ran out.
    const later = Date.now() + 121_000;
    store.now = () => new Date(later);

    const next = runnerOn(store);
    next.register("SPREADSHEET_IMPORT", handler(null));

    await next.processBatch();

    expect(effects).toEqual([0, 1, 2, 3, 4, 5]);
    expect(statusOf(store, id)).toMatchObject({
      status: "SUCCEEDED",
      attempts: 2,
    });

    // The old process wakes up: its write is refused by the fence.
    await expect(store.checkpoint(id, 1, { next: 4 })).rejects.toBeInstanceOf(
      JobLeaseLostError,
    );
  });

  it("beats the worker's heartbeat at every checkpoint of a long job", async () => {
    // A job runs for minutes inside one cycle: without a beat per
    // checkpoint, the worker-stuck rule took it for a hung cycle.
    const store = new InMemoryBackgroundJobRepository();
    const runner = runnerOn(store);
    const progress = vi.spyOn(workerHeartbeat, "progress");

    runner.register("SPREADSHEET_IMPORT", {
      run: async (job) => {
        progress.mockClear();

        for (let row = 0; row < 3; row += 1) {
          await job.checkpoint({ next: row + 1 });
        }

        expect(
          progress.mock.calls.filter(
            ([worker]) => worker === "background-jobs",
          ),
        ).toHaveLength(3);
      },
    });

    const id = await enqueue(store);

    await runner.processBatch();

    expect(statusOf(store, id).status).toBe("SUCCEEDED");
    progress.mockRestore();
  });

  it("runs one job of a company at a time when its kind caps it", async () => {
    const store = new InMemoryBackgroundJobRepository();
    const runner = runnerOn(store, 2);
    const order: string[] = [];
    let concurrent = 0;
    let peak = 0;

    runner.register("SPREADSHEET_IMPORT", {
      maxRunningPerTenant: () => 1,
      run: async (job) => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        order.push(String((job.payload as { n: number }).n));
        await new Promise((resolve) => setTimeout(resolve, 5));
        concurrent -= 1;
      },
    });

    await enqueue(store, { payload: { n: 1 } });
    await enqueue(store, { payload: { n: 2 } });

    // The first claim takes one; the second job waits for it.
    await runner.processBatch();
    await runner.processBatch();

    expect(peak).toBe(1);
    expect(order).toEqual(["1", "2"]);
  });
});
