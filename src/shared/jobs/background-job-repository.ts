import { Prisma, type PrismaClient } from "@prisma/client";

import database from "@/../infra/database";
import {
  columnOf,
  fairClaimSql,
  nextFairCursor,
  type FairQueue,
} from "@/shared/queue/fair-claim";

import { JobLeaseLostError } from "./job-errors";

/**
 * The durable jobs' table, background_job (plano-escala F3-22): every
 * read and write of it goes through here, the runner's and the use cases'
 * that enqueue.
 *
 * The rules the runner leans on:
 *
 *  - the claim is the fair claim of the other queues (company by company
 *    from a rotating cursor, shared/queue/fair-claim.ts) with SKIP LOCKED:
 *    two processes never take the same job, and one company's twenty
 *    uploads do not put every other company's behind them. It bumps
 *    `attempts` and leases the job for LEASE_SECONDS;
 *  - every write after the claim is FENCED on `attempts`: `WHERE id = $1
 *    AND attempts = $n AND status = 'PROCESSING'`. A process whose lease
 *    ran out, and whose job another process claimed since (attempts + 1),
 *    can no longer move the cursor, finish, fail or hand back the job. The
 *    checkpoint can run inside the caller's transaction, so the job's
 *    effects and its cursor commit together or not at all: that is what
 *    makes a SIGKILL resume without doing anything twice;
 *  - a kind may cap the jobs RUNNING per company (the spreadsheet import:
 *    one at a time): the claim leaves a company's job behind while
 *    another of the same kind runs with a live lease. Two claims of the
 *    very same instant can still both pass (each sees the other's row
 *    uncommitted), which a cap of memory, not of correctness, accepts;
 *  - `enqueueWithCap` counts the company's live jobs of the kind and
 *    inserts in one transaction under pg_advisory_xact_lock('job-cap:
 *    <kind>:<businessId>'): two uploads at once cannot both take the last
 *    place;
 *  - one live job per kind and subject (the unique index): enqueuing the
 *    same work again answers with the job already there.
 */

const BACKGROUND_JOB_KINDS = [
  "SPREADSHEET_IMPORT",
  "IMPORT_REVERSAL",
  "TENANT_OFFBOARD",
  "USER_ANONYMIZE",
  "PARTITION_ARCHIVE",
  "ROLLUP_BACKFILL",
] as const;

type BackgroundJobKind = (typeof BACKGROUND_JOB_KINDS)[number];

type BackgroundJobStatus =
  "PENDING" | "PROCESSING" | "SUCCEEDED" | "FAILED" | "CANCELLED";

/**
 * How long a claim holds a job. The runner renews it every
 * LEASE_RENEW_EVERY_MS while the job runs, and every checkpoint renews it
 * too: a job is lost to another process only when its process stopped
 * answering for two renewals and more.
 */
const LEASE_SECONDS = 120;

/** A third of the lease: two renewals may fail before it runs out. */
const LEASE_RENEW_EVERY_MS = 40_000;

/** Attempts a job gets unless its kind says otherwise. */
const DEFAULT_MAX_ATTEMPTS = 5;

/** The longest error kept on the row: enough to read, never a dump. */
const LAST_ERROR_MAX_LENGTH = 1_000;

interface BackgroundJobRow {
  id: string;
  kind: BackgroundJobKind;
  businessId: string | null;
  subjectId: string | null;
  status: BackgroundJobStatus;
  availableAt: Date;
  attempts: number;
  maxAttempts: number;
  leaseExpiresAt: Date | null;
  leaseOwner: string | null;
  progress: unknown;
  payload: unknown;
  lastError: string | null;
  created_at: Date;
  updated_at: Date;
  finished_at: Date | null;
}

/** A job as the claim hands it over. */
interface ClaimedJob {
  id: string;
  kind: BackgroundJobKind;
  businessId: string | null;
  subjectId: string | null;
  attempts: number;
  maxAttempts: number;
  payload: unknown;
  progress: unknown;
}

/** The caller's transaction, or nothing (the twin has none). */
type JobTransaction = Prisma.TransactionClient | undefined;

interface EnqueueJobInput {
  kind: BackgroundJobKind;
  businessId: string | null;

  /** The record worked on: one live job per kind and subject. */
  subjectId?: string | null;

  payload: Record<string, unknown>;

  /** Not before this instant (a scheduled purge); now by default. */
  availableAt?: Date;

  maxAttempts?: number;
}

type EnqueueOutcome =
  /** Written now. */
  | { outcome: "enqueued"; job: BackgroundJobRow }
  /** A live job of the same kind and subject was already there. */
  | { outcome: "existing"; job: BackgroundJobRow };

type CappedEnqueueOutcome =
  | EnqueueOutcome
  /** The company already has `live` jobs of the kind, the cap or more. */
  | { outcome: "busy"; live: number };

interface CappedEnqueueInput extends EnqueueJobInput {
  businessId: string;

  /** Live jobs (PENDING or PROCESSING) of the kind the company may have. */
  limit: number;

  /**
   * Writes the job's domain record in the job's own transaction (the
   * upload's record): both commit, or neither. Not called when the cap
   * refuses.
   */
  prepare?: (tx: JobTransaction) => Promise<void>;
}

interface ClaimJobsInput {
  limit: number;

  /** The process taking the lease (its heartbeat replica), for the logs. */
  owner: string;

  /** Only these kinds: the ones this process has a handler for. */
  kinds: readonly BackgroundJobKind[];

  /** Jobs of a kind running at once per company; absent = no cap. */
  runningPerTenant?: Partial<Record<BackgroundJobKind, number>>;

  /** Where the fair walk starts; '' = the first company. */
  cursor: string;

  /** Companies visited per claim (QUEUE_FAIR_MAX_TENANTS). */
  maxTenants: number;
}

interface ClaimJobsResult {
  jobs: ClaimedJob[];

  /** Where this process's next claim starts. */
  cursor: string;
}

interface IBackgroundJobRepository {
  /**
   * Writes a job, inside the caller's transaction when `tx` is given (the
   * caller wakes the queue after its commit: wakeJobsAfterCommit). A live
   * job of the same kind and subject is answered instead of a second.
   */
  enqueue(input: EnqueueJobInput, tx?: JobTransaction): Promise<EnqueueOutcome>;

  /** `enqueue` under the company's cap for the kind (see the top). */
  enqueueWithCap(input: CappedEnqueueInput): Promise<CappedEnqueueOutcome>;

  /** Due jobs for the runner, leased to `owner`, fairly by company. */
  claim(input: ClaimJobsInput): Promise<ClaimJobsResult>;

  /** Extends the lease; false when it is no longer this attempt's. */
  renewLease(id: string, attempts: number): Promise<boolean>;

  /**
   * Writes the cursor and extends the lease, fenced on `attempts`; with
   * `tx`, inside the caller's transaction. Throws JobLeaseLostError when
   * the job is no longer this attempt's — inside a transaction, that rolls
   * back whatever it did.
   */
  checkpoint(
    id: string,
    attempts: number,
    progress: unknown,
    tx?: JobTransaction,
  ): Promise<void>;

  /** SUCCEEDED; false when the lease was lost before. */
  complete(id: string, attempts: number): Promise<boolean>;

  /** Back to PENDING after `delayMs`, the attempt spent. */
  retry(
    id: string,
    attempts: number,
    error: string,
    delayMs: number,
  ): Promise<boolean>;

  /** FAILED for good. */
  fail(id: string, attempts: number, error: string): Promise<boolean>;

  /**
   * Back to PENDING now, the attempt NOT spent (the process is stopping):
   * the next claim resumes it from its cursor.
   */
  giveBack(id: string, attempts: number): Promise<boolean>;

  /**
   * Cancels the live job of `kind` and `subjectId` of the company while it
   * still waits (PENDING): a job already running is never cancelled here.
   * Answers how many were cancelled (0 or 1).
   */
  cancelPending(
    kind: BackgroundJobKind,
    subjectId: string,
    businessId: string | null,
  ): Promise<number>;

  /** The live job of `kind` and `subjectId`, or null. */
  findLive(
    kind: BackgroundJobKind,
    subjectId: string,
  ): Promise<BackgroundJobRow | null>;

  findById(id: string): Promise<BackgroundJobRow | null>;
}

function trimError(error: string): string {
  return error.length > LAST_ERROR_MAX_LENGTH
    ? `${error.slice(0, LAST_ERROR_MAX_LENGTH)}…`
    : error;
}

const KIND_PATTERN = /^[A-Z_]+$/;

/** A kind as an SQL literal: constants of the code, never input. */
function kindLiteral(kind: BackgroundJobKind): Prisma.Sql {
  if (
    !KIND_PATTERN.test(kind) ||
    !(BACKGROUND_JOB_KINDS as readonly string[]).includes(kind)
  ) {
    throw new Error(`background_job: tipo de job inválido "${kind}"`);
  }

  return Prisma.raw(`'${kind}'`);
}

/**
 * The cap of jobs running at once per company, by kind, as an SQL
 * predicate on `alias`: no other job of the same company and kind holds a
 * live lease beyond the cap. True for the kinds without a cap and for the
 * platform's jobs (no company).
 */
function runningCapSql(
  alias: string | null,
  caps: Partial<Record<BackgroundJobKind, number>>,
): Prisma.Sql {
  const capped = Object.entries(caps).filter(
    ([, cap]) => cap !== undefined && Number.isInteger(cap) && cap >= 1,
  ) as Array<[BackgroundJobKind, number]>;

  if (capped.length === 0) return Prisma.sql`true`;

  const self = alias ?? "background_job";
  const kind = columnOf(self, "kind");
  const cases = capped.map(
    ([name, cap]) =>
      Prisma.sql`WHEN ${kindLiteral(name)} THEN ${Prisma.raw(String(cap))}`,
  );

  return Prisma.sql`(
    ${columnOf(self, "businessId")} IS NULL
    OR ${kind} NOT IN (${Prisma.join(capped.map(([name]) => kindLiteral(name)))})
    OR (
      SELECT count(*) FROM "background_job" AS "other"
      WHERE "other"."businessId" = ${columnOf(self, "businessId")}
        AND "other"."kind" = ${kind}
        AND "other"."status" = 'PROCESSING'
        AND "other"."leaseExpiresAt" >= now()
        AND "other"."id" <> ${columnOf(self, "id")}
    ) < CASE ${kind} ${Prisma.join(cases, " ")} END
  )`;
}

/** The queue as the fair claim walks it, for one claim's settings. */
function jobFairQueue(input: ClaimJobsInput): FairQueue {
  const kinds = Prisma.join(input.kinds.map(kindLiteral));
  const caps = input.runningPerTenant ?? {};

  return {
    table: "background_job",
    tenant: "businessId",
    dueAt: "availableAt",
    indexed: (alias) =>
      Prisma.sql`${columnOf(alias, "status")} IN ('PENDING', 'PROCESSING')`,
    due: (alias) =>
      Prisma.sql`${columnOf(alias, "availableAt")} <= now() AND (${columnOf(alias, "status")} = 'PENDING' OR ${columnOf(alias, "leaseExpiresAt")} < now()) AND ${columnOf(alias, "kind")} IN (${kinds}) AND ${runningCapSql(alias, caps)}`,
    // One job of a company per claim, and no fill by age: a job is long,
    // and a claim that took a second job of a capped company would run
    // two at once.
    fill: false,
    // The company's job is locked as the walk reads it, skipping one that
    // another process's claim holds (the webhooks' way, fair-claim.ts):
    // read first and locked at the end, a claim of two that met two held
    // jobs would come back empty with the queue full behind them. The
    // platform's jobs (no company) are read without it: a claim that meets
    // one held comes back short, and the next sweep takes the rest.
    share: () => Prisma.sql`1`,
    set: Prisma.sql`
      "status" = 'PROCESSING',
      "leaseExpiresAt" = now() + make_interval(secs => ${LEASE_SECONDS}),
      "leaseOwner" = ${input.owner},
      "attempts" = "attempts" + 1,
      "updated_at" = now()`,
    returning: `"id", "kind"::text AS "kind", "businessId", "subjectId", "attempts", "maxAttempts", "payload", "progress"`,
  };
}

/** The claim's statement, exported for the plan and SQL tests. */
function jobClaimSql(input: ClaimJobsInput): Prisma.Sql {
  return fairClaimSql(jobFairQueue(input), {
    cursor: input.cursor,
    limit: input.limit,
    rowsPerTenant: 1,
    maxTenants: input.maxTenants,
    // background_job is not partitioned: no claim floor.
    floor: Prisma.empty,
    rowFloor: Prisma.empty,
  });
}

function isLiveSubjectConflict(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

type Client = PrismaClient | Prisma.TransactionClient;

class BackgroundJobRepository implements IBackgroundJobRepository {
  constructor(private readonly prisma: PrismaClient = database) {}

  async enqueue(
    input: EnqueueJobInput,
    tx?: JobTransaction,
  ): Promise<EnqueueOutcome> {
    if (input.subjectId) {
      const live = await this.liveOn(tx ?? this.prisma, input);

      if (live) return { outcome: "existing", job: live };
    }

    try {
      const job = await this.insert(tx ?? this.prisma, input);

      return { outcome: "enqueued", job };
    } catch (error) {
      // Two enqueues of one subject at once: the index let one in.
      if (!tx && input.subjectId && isLiveSubjectConflict(error)) {
        const live = await this.liveOn(this.prisma, input);

        if (live) return { outcome: "existing", job: live };
      }

      throw error;
    }
  }

  async enqueueWithCap(
    input: CappedEnqueueInput,
  ): Promise<CappedEnqueueOutcome> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`job-cap:${input.kind}:${input.businessId}`}, 0))`;

      if (input.subjectId) {
        const live = await this.liveOn(tx, input);

        if (live) return { outcome: "existing" as const, job: live };
      }

      const [{ live }] = await tx.$queryRaw<Array<{ live: number }>>`
        SELECT count(*)::int AS "live" FROM "background_job"
        WHERE "businessId" = ${input.businessId}
          AND "kind" = ${input.kind}::"BackgroundJobKind"
          AND "status" IN ('PENDING', 'PROCESSING')
      `;

      if (live >= input.limit) return { outcome: "busy" as const, live };

      await input.prepare?.(tx);

      const job = await this.insert(tx, input);

      return { outcome: "enqueued" as const, job };
    });
  }

  async claim(input: ClaimJobsInput): Promise<ClaimJobsResult> {
    if (input.kinds.length === 0 || input.limit < 1) {
      return { jobs: [], cursor: input.cursor };
    }

    const rows = await this.prisma.$queryRaw<
      Array<ClaimedJob & { fairCursor: string | null }>
    >(jobClaimSql(input));

    return {
      jobs: rows.map(({ fairCursor: _cursor, ...job }) => job),
      cursor: nextFairCursor(rows, input.cursor),
    };
  }

  async renewLease(id: string, attempts: number): Promise<boolean> {
    const updated = await this.prisma.$executeRaw`
      UPDATE "background_job"
      SET "leaseExpiresAt" = now() + make_interval(secs => ${LEASE_SECONDS}),
          "updated_at" = now()
      WHERE "id" = ${id} AND "attempts" = ${attempts}
        AND "status" = 'PROCESSING'
    `;

    return updated === 1;
  }

  async checkpoint(
    id: string,
    attempts: number,
    progress: unknown,
    tx?: JobTransaction,
  ): Promise<void> {
    const client: Client = tx ?? this.prisma;
    const updated = await client.$executeRaw`
      UPDATE "background_job"
      SET "progress" = ${JSON.stringify(progress ?? null)}::jsonb,
          "leaseExpiresAt" = now() + make_interval(secs => ${LEASE_SECONDS}),
          "updated_at" = now()
      WHERE "id" = ${id} AND "attempts" = ${attempts}
        AND "status" = 'PROCESSING'
    `;

    if (updated !== 1) throw new JobLeaseLostError(id);
  }

  async complete(id: string, attempts: number): Promise<boolean> {
    const updated = await this.prisma.$executeRaw`
      UPDATE "background_job"
      SET "status" = 'SUCCEEDED', "leaseExpiresAt" = NULL,
          "finished_at" = now(), "updated_at" = now()
      WHERE "id" = ${id} AND "attempts" = ${attempts}
        AND "status" = 'PROCESSING'
    `;

    return updated === 1;
  }

  async retry(
    id: string,
    attempts: number,
    error: string,
    delayMs: number,
  ): Promise<boolean> {
    const updated = await this.prisma.$executeRaw`
      UPDATE "background_job"
      SET "status" = 'PENDING', "leaseExpiresAt" = NULL,
          "availableAt" = now() + make_interval(secs => ${Math.max(0, delayMs) / 1000}),
          "lastError" = ${trimError(error)}, "updated_at" = now()
      WHERE "id" = ${id} AND "attempts" = ${attempts}
        AND "status" = 'PROCESSING'
    `;

    return updated === 1;
  }

  async fail(id: string, attempts: number, error: string): Promise<boolean> {
    const updated = await this.prisma.$executeRaw`
      UPDATE "background_job"
      SET "status" = 'FAILED', "leaseExpiresAt" = NULL,
          "lastError" = ${trimError(error)},
          "finished_at" = now(), "updated_at" = now()
      WHERE "id" = ${id} AND "attempts" = ${attempts}
        AND "status" = 'PROCESSING'
    `;

    return updated === 1;
  }

  async giveBack(id: string, attempts: number): Promise<boolean> {
    const updated = await this.prisma.$executeRaw`
      UPDATE "background_job"
      SET "status" = 'PENDING', "leaseExpiresAt" = NULL,
          "attempts" = GREATEST("attempts" - 1, 0),
          "availableAt" = now(), "updated_at" = now()
      WHERE "id" = ${id} AND "attempts" = ${attempts}
        AND "status" = 'PROCESSING'
    `;

    return updated === 1;
  }

  async cancelPending(
    kind: BackgroundJobKind,
    subjectId: string,
    businessId: string | null,
  ): Promise<number> {
    return this.prisma.$executeRaw`
      UPDATE "background_job"
      SET "status" = 'CANCELLED', "finished_at" = now(), "updated_at" = now()
      WHERE "kind" = ${kind}::"BackgroundJobKind"
        AND "subjectId" = ${subjectId}
        AND "businessId" IS NOT DISTINCT FROM ${businessId}
        AND "status" = 'PENDING'
    `;
  }

  async findLive(
    kind: BackgroundJobKind,
    subjectId: string,
  ): Promise<BackgroundJobRow | null> {
    return this.liveOn(this.prisma, { kind, subjectId });
  }

  async findById(id: string): Promise<BackgroundJobRow | null> {
    return (await this.prisma.backgroundJob.findUnique({
      where: { id },
    })) as BackgroundJobRow | null;
  }

  private async liveOn(
    client: Client,
    { kind, subjectId }: { kind: BackgroundJobKind; subjectId?: string | null },
  ): Promise<BackgroundJobRow | null> {
    if (!subjectId) return null;

    return (await client.backgroundJob.findFirst({
      where: { kind, subjectId, status: { in: ["PENDING", "PROCESSING"] } },
    })) as BackgroundJobRow | null;
  }

  private async insert(
    client: Client,
    input: EnqueueJobInput,
  ): Promise<BackgroundJobRow> {
    return (await client.backgroundJob.create({
      data: {
        kind: input.kind,
        businessId: input.businessId,
        subjectId: input.subjectId ?? null,
        payload: input.payload as Prisma.InputJsonValue,
        maxAttempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
        ...(input.availableAt && { availableAt: input.availableAt }),
      },
    })) as BackgroundJobRow;
  }
}

export {
  BACKGROUND_JOB_KINDS,
  BackgroundJobRepository,
  DEFAULT_MAX_ATTEMPTS,
  LAST_ERROR_MAX_LENGTH,
  LEASE_RENEW_EVERY_MS,
  LEASE_SECONDS,
  jobClaimSql,
  trimError,
};
export type {
  BackgroundJobKind,
  BackgroundJobRow,
  BackgroundJobStatus,
  CappedEnqueueInput,
  CappedEnqueueOutcome,
  ClaimJobsInput,
  ClaimJobsResult,
  ClaimedJob,
  EnqueueJobInput,
  EnqueueOutcome,
  IBackgroundJobRepository,
  JobTransaction,
};
