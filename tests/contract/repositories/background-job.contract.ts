import { beforeEach, expect, it } from "vitest";

import type { IBackgroundJobRepository } from "@/shared/jobs/background-job-repository";
import { JobLeaseLostError } from "@/shared/jobs/job-errors";

import type { Kind } from "../support";

/**
 * The durable jobs' table (plano-escala F3-22), the same expectations for
 * the SQL and for the twin the unit suites run the JobRunner on:
 *
 *  - one live job per kind and subject; the cap per company and kind,
 *    with the domain record written only when the job is;
 *  - the claim: due jobs of the listed kinds only, one per company per
 *    claim, the companies in turn from the cursor, the platform's jobs
 *    after the last company; the cap of jobs running per company;
 *  - the fence: once another attempt holds the job, the old one can no
 *    longer checkpoint, finish, fail, retry or hand it back;
 *  - a lease that ran out makes the job claimable again, attempts + 1;
 *  - the hand-back gives the attempt back and keeps the cursor;
 *  - only a waiting job is cancelled.
 */
interface BackgroundJobHarness {
  kind: Kind;
  repo: IBackgroundJobRepository;

  /** Forgets every job. */
  reset(): Promise<void>;

  /** Makes the job's lease run out now. */
  expireLease(id: string): Promise<void>;
}

const A = "018fd100-0000-7000-8000-0000000000a1";
const B = "018fd100-0000-7000-8000-0000000000b1";
const C = "018fd100-0000-7000-8000-0000000000c1";

const KINDS = ["SPREADSHEET_IMPORT", "IMPORT_REVERSAL"] as const;

/** The companies of a claim, sorted: an UPDATE returns in no set order. */
const companiesOf = (jobs: Array<{ businessId: string | null }>) =>
  jobs.map((job) => job.businessId ?? "(plataforma)").sort();

function backgroundJobContract(harness: () => BackgroundJobHarness): void {
  beforeEach(async () => {
    await harness().reset();
  });

  const claim = (
    limit: number,
    options: {
      cursor?: string;
      kinds?: readonly (typeof KINDS)[number][];
      cap?: number;
    } = {},
  ) =>
    harness().repo.claim({
      limit,
      owner: "contract",
      kinds: options.kinds ?? KINDS,
      cursor: options.cursor ?? "",
      maxTenants: 64,
      ...(options.cap !== undefined && {
        runningPerTenant: { SPREADSHEET_IMPORT: options.cap },
      }),
    });

  const enqueue = async (
    businessId: string | null,
    extra: {
      subjectId?: string;
      kind?: "SPREADSHEET_IMPORT" | "IMPORT_REVERSAL" | "TENANT_OFFBOARD";
      availableAt?: Date;
    } = {},
  ) => {
    const outcome = await harness().repo.enqueue({
      kind: extra.kind ?? "SPREADSHEET_IMPORT",
      businessId,
      subjectId: extra.subjectId ?? null,
      payload: { businessId },
      ...(extra.availableAt && { availableAt: extra.availableAt }),
    });

    return outcome.job.id;
  };

  it("keeps one live job per kind and subject", async () => {
    const { repo } = harness();
    const first = await repo.enqueue({
      kind: "SPREADSHEET_IMPORT",
      businessId: A,
      subjectId: "upload-1",
      payload: { n: 1 },
    });
    const again = await repo.enqueue({
      kind: "SPREADSHEET_IMPORT",
      businessId: A,
      subjectId: "upload-1",
      payload: { n: 2 },
    });

    expect(first.outcome).toBe("enqueued");
    expect(again).toMatchObject({
      outcome: "existing",
      job: { id: first.job.id, payload: { n: 1 } },
    });

    // Another kind of the same subject is another job.
    const undo = await repo.enqueue({
      kind: "IMPORT_REVERSAL",
      businessId: A,
      subjectId: "upload-1",
      payload: {},
    });

    expect(undo.outcome).toBe("enqueued");
    expect(await repo.findLive("SPREADSHEET_IMPORT", "upload-1")).toMatchObject(
      { id: first.job.id, status: "PENDING", attempts: 0 },
    );
  });

  it("caps the live jobs of a kind per company, writing the record only with the job", async () => {
    const { repo } = harness();
    const prepared: string[] = [];

    const capped = (subjectId: string, businessId = A) =>
      repo.enqueueWithCap({
        kind: "SPREADSHEET_IMPORT",
        businessId,
        subjectId,
        payload: {},
        limit: 2,
        prepare: async () => {
          prepared.push(subjectId);
        },
      });

    expect((await capped("u-1")).outcome).toBe("enqueued");
    expect((await capped("u-2")).outcome).toBe("enqueued");
    expect(await capped("u-3")).toEqual({ outcome: "busy", live: 2 });

    // Another company, another kind: their own counts.
    expect((await capped("u-4", B)).outcome).toBe("enqueued");
    expect(
      (
        await repo.enqueueWithCap({
          kind: "IMPORT_REVERSAL",
          businessId: A,
          subjectId: "u-1",
          payload: {},
          limit: 2,
        })
      ).outcome,
    ).toBe("enqueued");

    expect(prepared).toEqual(["u-1", "u-2", "u-4"]);

    // A finished job frees its place.
    const [job] = (await claim(1, { kinds: ["SPREADSHEET_IMPORT"] })).jobs;
    await repo.complete(job.id, job.attempts);

    expect((await capped("u-5", job.businessId!)).outcome).toBe("enqueued");
  });

  it("claims one job per company in turn from the cursor, the platform's after the last company", async () => {
    await enqueue(A);
    await enqueue(A);
    await enqueue(A);
    await enqueue(B);
    await enqueue(null, { kind: "IMPORT_REVERSAL" });

    const first = await claim(2);

    expect(companiesOf(first.jobs)).toEqual([A, B]);
    expect(first.cursor).toBe(B);

    // From B on: the platform's bucket, then the wrap to A.
    const second = await claim(2, { cursor: first.cursor });

    expect(companiesOf(second.jobs)).toEqual(["(plataforma)", A]);
    expect(second.jobs.every((job) => job.attempts === 1)).toBe(true);
  });

  it("claims only due jobs of the kinds asked for", async () => {
    await enqueue(A, { availableAt: new Date(Date.now() + 3_600_000) });
    await enqueue(B, { kind: "TENANT_OFFBOARD", subjectId: B });
    const due = await enqueue(C);

    const { jobs } = await claim(5);

    expect(jobs.map((job) => job.id)).toEqual([due]);
    expect(jobs[0]).toMatchObject({
      kind: "SPREADSHEET_IMPORT",
      businessId: C,
      attempts: 1,
      payload: { businessId: C },
      progress: null,
    });
  });

  it("leaves a company's second job behind while one runs, under the cap", async () => {
    await enqueue(A);
    await enqueue(A);
    await enqueue(null);

    const [running] = (await claim(1, { cap: 1 })).jobs;

    expect(running.businessId).toBe(A);

    // A's other job waits; the platform's is no company's.
    const next = await claim(5, { cap: 1 });

    expect(next.jobs.map((job) => job.businessId)).toEqual([null]);

    // Without the cap, it is taken.
    expect((await claim(5)).jobs.map((job) => job.businessId)).toEqual([A]);
  });

  it("refuses every write of an attempt that no longer holds the job", async () => {
    const { repo } = harness();
    const id = await enqueue(A);
    const [job] = (await claim(1)).jobs;

    await harness().expireLease(id);

    const [again] = (await claim(1)).jobs;

    expect(again).toMatchObject({ id, attempts: 2 });

    await expect(
      repo.checkpoint(id, job.attempts, { next: 1 }),
    ).rejects.toBeInstanceOf(JobLeaseLostError);
    expect(await repo.renewLease(id, job.attempts)).toBe(false);
    expect(await repo.complete(id, job.attempts)).toBe(false);
    expect(await repo.retry(id, job.attempts, "x", 0)).toBe(false);
    expect(await repo.fail(id, job.attempts, "x")).toBe(false);
    expect(await repo.giveBack(id, job.attempts)).toBe(false);

    // The holder's own writes pass.
    await repo.checkpoint(id, again.attempts, { next: 7 });
    expect(await repo.renewLease(id, again.attempts)).toBe(true);
    expect(await repo.complete(id, again.attempts)).toBe(true);
    expect(await repo.findById(id)).toMatchObject({
      status: "SUCCEEDED",
      attempts: 2,
      progress: { next: 7 },
      leaseExpiresAt: null,
    });
  });

  it("hands a job back with its attempt and its cursor", async () => {
    const { repo } = harness();
    const id = await enqueue(A);
    const [job] = (await claim(1)).jobs;

    await repo.checkpoint(id, job.attempts, { next: 40 });
    expect(await repo.giveBack(id, job.attempts)).toBe(true);

    const [resumed] = (await claim(1)).jobs;

    expect(resumed).toMatchObject({
      id,
      attempts: 1,
      progress: { next: 40 },
    });
  });

  it("puts a retried job back after its delay, the attempt spent", async () => {
    const { repo } = harness();
    const id = await enqueue(A);
    const [job] = (await claim(1)).jobs;

    expect(await repo.retry(id, job.attempts, "boom", 3_600_000)).toBe(true);
    expect((await claim(1)).jobs).toEqual([]);
    expect(await repo.findById(id)).toMatchObject({
      status: "PENDING",
      attempts: 1,
      lastError: "boom",
    });

    expect(await repo.retry(id, job.attempts, "again", 0)).toBe(false);
  });

  it("gives a job that must finish one attempt more when retried past its last", async () => {
    const { repo } = harness();
    const { job: queued } = await repo.enqueue({
      kind: "SPREADSHEET_IMPORT",
      businessId: A,
      payload: {},
      maxAttempts: 1,
    });
    const [job] = (await claim(1)).jobs;

    expect(job.id).toBe(queued.id);
    expect(
      await repo.retry(queued.id, job.attempts, "r2 down", 0, {
        oneMore: true,
      }),
    ).toBe(true);
    expect(await repo.findById(queued.id)).toMatchObject({
      status: "PENDING",
      attempts: 1,
      maxAttempts: 2,
      lastError: "r2 down",
    });

    // A plain retry never moves the ceiling.
    const [again] = (await claim(1)).jobs;

    expect(await repo.retry(queued.id, again.attempts, "x", 0)).toBe(true);
    expect(await repo.findById(queued.id)).toMatchObject({
      attempts: 2,
      maxAttempts: 2,
    });
  });

  it("says when the next job that cannot be claimed yet becomes claimable", async () => {
    const { repo, expireLease } = harness();

    expect(await repo.nextClaimableInMs(KINDS)).toBeNull();

    // Due now: claimable already, so not "next".
    const due = await enqueue(A);

    expect(await repo.nextClaimableInMs(KINDS)).toBeNull();

    // A backoff ending in an hour.
    await enqueue(B, { availableAt: new Date(Date.now() + 3_600_000) });

    const inAnHour = await repo.nextClaimableInMs(KINDS);

    expect(inAnHour).toBeGreaterThan(3_500_000);
    expect(inAnHour).toBeLessThanOrEqual(3_600_000);

    // A running job's lease (120 s) comes first; once it ran out (its
    // process died), it is claimable and the hour is next again.
    const [running] = (await claim(1)).jobs;

    expect(running.id).toBe(due);

    const lease = await repo.nextClaimableInMs(KINDS);

    expect(lease).toBeGreaterThan(100_000);
    expect(lease).toBeLessThanOrEqual(120_000);

    await expireLease(due);

    expect(await repo.nextClaimableInMs(KINDS)).toBeGreaterThan(3_500_000);

    // Only the kinds asked for.
    expect(await repo.nextClaimableInMs(["TENANT_OFFBOARD"])).toBeNull();
  });

  it("cancels only a job still waiting, of that company", async () => {
    const { repo } = harness();
    const waiting = await enqueue(A, {
      kind: "TENANT_OFFBOARD",
      subjectId: A,
      availableAt: new Date(Date.now() + 86_400_000),
    });

    expect(await repo.cancelPending("TENANT_OFFBOARD", A, B)).toBe(0);
    expect(await repo.cancelPending("TENANT_OFFBOARD", A, A)).toBe(1);
    expect(await repo.findById(waiting)).toMatchObject({ status: "CANCELLED" });
    expect(await repo.findLive("TENANT_OFFBOARD", A)).toBeNull();

    // A running job is not cancelled here.
    await enqueue(B, { subjectId: "u-9" });
    const [running] = (await claim(1)).jobs;

    expect(await repo.cancelPending("SPREADSHEET_IMPORT", "u-9", B)).toBe(0);
    expect(await repo.findById(running.id)).toMatchObject({
      status: "PROCESSING",
    });
  });
}

export { A, B, C, backgroundJobContract };
export type { BackgroundJobHarness };
