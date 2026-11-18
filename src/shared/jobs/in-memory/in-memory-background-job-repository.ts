import { v7 as uuidV7 } from "uuid";

import {
  DEFAULT_MAX_ATTEMPTS,
  LEASE_SECONDS,
  trimError,
  type BackgroundJobKind,
  type BackgroundJobRow,
  type CappedEnqueueInput,
  type CappedEnqueueOutcome,
  type ClaimJobsInput,
  type ClaimJobsResult,
  type ClaimedJob,
  type EnqueueJobInput,
  type EnqueueOutcome,
  type IBackgroundJobRepository,
  type JobTransaction,
} from "../background-job-repository";
import { JobLeaseLostError } from "../job-errors";

/**
 * The twin of BackgroundJobRepository, with the same semantics: the claim
 * walks the companies from the cursor (one job each, the platform's after
 * the last company, then the wrap), the running cap per company, the lease
 * and the fence on `attempts`, one live job per kind and subject. The
 * contract suite (tests/contract/repositories/background-job.contract.ts)
 * holds the two to the same expectations.
 */
class InMemoryBackgroundJobRepository implements IBackgroundJobRepository {
  public jobs: BackgroundJobRow[] = [];

  /** The clock; a test moves it to expire a lease. */
  public now: () => Date = () => new Date();

  async enqueue(
    input: EnqueueJobInput,
    _tx?: JobTransaction,
  ): Promise<EnqueueOutcome> {
    const live = this.live(input.kind, input.subjectId);

    if (live) return { outcome: "existing", job: { ...live } };

    return { outcome: "enqueued", job: { ...this.insert(input) } };
  }

  async enqueueWithCap(
    input: CappedEnqueueInput,
  ): Promise<CappedEnqueueOutcome> {
    const existing = this.live(input.kind, input.subjectId);

    if (existing) return { outcome: "existing", job: { ...existing } };

    const live = this.jobs.filter(
      (job) =>
        job.businessId === input.businessId &&
        job.kind === input.kind &&
        (job.status === "PENDING" || job.status === "PROCESSING"),
    ).length;

    if (live >= input.limit) return { outcome: "busy", live };

    await input.prepare?.(undefined);

    return { outcome: "enqueued", job: { ...this.insert(input) } };
  }

  async claim(input: ClaimJobsInput): Promise<ClaimJobsResult> {
    const now = this.now().getTime();
    const caps = input.runningPerTenant ?? {};

    const runningOf = (job: BackgroundJobRow) =>
      this.jobs.filter(
        (other) =>
          other.id !== job.id &&
          other.businessId === job.businessId &&
          other.kind === job.kind &&
          other.status === "PROCESSING" &&
          other.leaseExpiresAt !== null &&
          other.leaseExpiresAt.getTime() >= now,
      ).length;

    const due = (job: BackgroundJobRow) =>
      job.availableAt.getTime() <= now &&
      (job.status === "PENDING" ||
        (job.status === "PROCESSING" &&
          job.leaseExpiresAt !== null &&
          job.leaseExpiresAt.getTime() < now)) &&
      input.kinds.includes(job.kind) &&
      (job.businessId === null ||
        caps[job.kind] === undefined ||
        runningOf(job) < caps[job.kind]!);

    const oldestDue = (rows: BackgroundJobRow[]) =>
      rows
        .filter(due)
        .sort(
          (left, right) =>
            left.availableAt.getTime() - right.availableAt.getTime() ||
            (left.id < right.id ? -1 : 1),
        )[0];

    // The companies with a claimable row (the fair index), in id order.
    const companies = [
      ...new Set(
        this.jobs
          .filter(
            (job) =>
              job.businessId !== null &&
              (job.status === "PENDING" || job.status === "PROCESSING"),
          )
          .map((job) => job.businessId!),
      ),
    ].sort();

    const picked: BackgroundJobRow[] = [];
    let visited = 0;
    let lastVisited: string | null = null;

    const visit = (company: string) => {
      visited += 1;
      lastVisited = company;

      const row = oldestDue(
        this.jobs.filter((job) => job.businessId === company),
      );

      if (row) picked.push(row);
    };

    const after = companies.filter((company) => company > input.cursor);

    for (const company of after) {
      if (picked.length >= input.limit || visited >= input.maxTenants) break;

      visit(company);
    }

    // The platform's bucket, then the wrap: only while short.
    if (picked.length < input.limit && visited < input.maxTenants) {
      const platform = oldestDue(
        this.jobs.filter((job) => job.businessId === null),
      );

      if (platform) picked.push(platform);
    }

    if (input.cursor !== "") {
      const before = companies.filter((company) => company <= input.cursor);

      for (const company of before) {
        if (picked.length >= input.limit || visited >= input.maxTenants) {
          break;
        }

        visit(company);
      }
    }

    const leaseUntil = new Date(now + LEASE_SECONDS * 1000);
    const claimed: ClaimedJob[] = picked.slice(0, input.limit).map((job) => {
      job.status = "PROCESSING";
      job.attempts += 1;
      job.leaseExpiresAt = leaseUntil;
      job.leaseOwner = input.owner;
      job.updated_at = new Date(now);

      return {
        id: job.id,
        kind: job.kind,
        businessId: job.businessId,
        subjectId: job.subjectId,
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
        payload: structuredClone(job.payload),
        progress: structuredClone(job.progress),
      };
    });

    return {
      jobs: claimed,
      cursor: claimed.length > 0 ? (lastVisited ?? "") : input.cursor,
    };
  }

  async renewLease(id: string, attempts: number): Promise<boolean> {
    const job = this.held(id, attempts);

    if (!job) return false;

    job.leaseExpiresAt = new Date(this.now().getTime() + LEASE_SECONDS * 1000);
    job.updated_at = this.now();

    return true;
  }

  async checkpoint(
    id: string,
    attempts: number,
    progress: unknown,
  ): Promise<void> {
    const job = this.held(id, attempts);

    if (!job) throw new JobLeaseLostError(id);

    job.progress = structuredClone(progress ?? null);
    job.leaseExpiresAt = new Date(this.now().getTime() + LEASE_SECONDS * 1000);
    job.updated_at = this.now();
  }

  async complete(id: string, attempts: number): Promise<boolean> {
    return this.settle(id, attempts, (job) => {
      job.status = "SUCCEEDED";
      job.finished_at = this.now();
    });
  }

  async retry(
    id: string,
    attempts: number,
    error: string,
    delayMs: number,
  ): Promise<boolean> {
    return this.settle(id, attempts, (job) => {
      job.status = "PENDING";
      job.availableAt = new Date(this.now().getTime() + Math.max(0, delayMs));
      job.lastError = trimError(error);
    });
  }

  async fail(id: string, attempts: number, error: string): Promise<boolean> {
    return this.settle(id, attempts, (job) => {
      job.status = "FAILED";
      job.lastError = trimError(error);
      job.finished_at = this.now();
    });
  }

  async giveBack(id: string, attempts: number): Promise<boolean> {
    return this.settle(id, attempts, (job) => {
      job.status = "PENDING";
      job.attempts = Math.max(job.attempts - 1, 0);
      job.availableAt = this.now();
    });
  }

  async cancelPending(
    kind: BackgroundJobKind,
    subjectId: string,
    businessId: string | null,
  ): Promise<number> {
    let cancelled = 0;

    for (const job of this.jobs) {
      if (
        job.kind === kind &&
        job.subjectId === subjectId &&
        job.businessId === businessId &&
        job.status === "PENDING"
      ) {
        job.status = "CANCELLED";
        job.finished_at = this.now();
        job.updated_at = this.now();
        cancelled += 1;
      }
    }

    return cancelled;
  }

  async findLive(
    kind: BackgroundJobKind,
    subjectId: string,
  ): Promise<BackgroundJobRow | null> {
    const live = this.live(kind, subjectId);

    return live ? { ...live } : null;
  }

  async findById(id: string): Promise<BackgroundJobRow | null> {
    const job = this.jobs.find((each) => each.id === id);

    return job ? { ...job } : null;
  }

  private live(
    kind: BackgroundJobKind,
    subjectId: string | null | undefined,
  ): BackgroundJobRow | undefined {
    if (!subjectId) return undefined;

    return this.jobs.find(
      (job) =>
        job.kind === kind &&
        job.subjectId === subjectId &&
        (job.status === "PENDING" || job.status === "PROCESSING"),
    );
  }

  /** The job while this attempt still holds it. */
  private held(id: string, attempts: number): BackgroundJobRow | undefined {
    return this.jobs.find(
      (job) =>
        job.id === id &&
        job.attempts === attempts &&
        job.status === "PROCESSING",
    );
  }

  private settle(
    id: string,
    attempts: number,
    change: (job: BackgroundJobRow) => void,
  ): boolean {
    const job = this.held(id, attempts);

    if (!job) return false;

    change(job);
    job.leaseExpiresAt = null;
    job.updated_at = this.now();

    return true;
  }

  private insert(input: EnqueueJobInput): BackgroundJobRow {
    const now = this.now();
    const job: BackgroundJobRow = {
      id: uuidV7(),
      kind: input.kind,
      businessId: input.businessId,
      subjectId: input.subjectId ?? null,
      status: "PENDING",
      availableAt: input.availableAt ?? now,
      attempts: 0,
      maxAttempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      leaseExpiresAt: null,
      leaseOwner: null,
      progress: null,
      payload: structuredClone(input.payload),
      lastError: null,
      created_at: now,
      updated_at: now,
      finished_at: null,
    };

    this.jobs.push(job);

    return job;
  }
}

export { InMemoryBackgroundJobRepository };
