import { afterAll, describe, expect, it, vi } from "vitest";

import { createPrismaClient } from "@/shared/database/database-client";
import {
  BackgroundJobRepository,
  type JobTransaction,
} from "@/shared/jobs/background-job-repository";
import { InMemoryBackgroundJobRepository } from "@/shared/jobs/in-memory/in-memory-background-job-repository";
import { JobLeaseLostError } from "@/shared/jobs/job-errors";
import { JobRunner, type JobContext } from "@/shared/jobs/job-runner";

import {
  A,
  B,
  backgroundJobContract,
  type BackgroundJobHarness,
} from "../contract/repositories/background-job.contract";
import { KINDS, type Kind } from "../contract/support";

/**
 * Plano-escala F3-22: background_job against Postgres and the twin (the
 * contract), plus what only the database can show:
 *
 *  - the fenced checkpoint inside the job's own transaction: an attempt
 *    that lost the job writes nothing, its effects rolled back with the
 *    refused cursor;
 *  - twelve uploads at once under a cap of three enqueue exactly three
 *    (pg_advisory_xact_lock('job-cap:<kind>:<company>'));
 *  - a SIGKILL: the runner dies mid-job, the lease runs out, another runner
 *    resumes from the cursor, and every effect exists once;
 *  - the nightly purge takes only the finished jobs past their retention.
 */
const prisma = createPrismaClient();
const memory = new InMemoryBackgroundJobRepository();

afterAll(async () => {
  await prisma.$disconnect();
});

const harnesses: Record<Kind, () => BackgroundJobHarness> = {
  prisma: () => ({
    kind: "prisma",
    repo: new BackgroundJobRepository(prisma),
    async reset() {
      await prisma.backgroundJob.deleteMany({});
    },
    async expireLease(id) {
      await prisma.$executeRaw`
        UPDATE "background_job"
        SET "leaseExpiresAt" = now() - interval '1 second'
        WHERE "id" = ${id}
      `;
    },
  }),
  "in-memory": () => ({
    kind: "in-memory",
    repo: memory,
    async reset() {
      memory.jobs = [];
      memory.now = () => new Date();
    },
    async expireLease(id) {
      const job = memory.jobs.find((each) => each.id === id)!;

      job.leaseExpiresAt = new Date(Date.now() - 1_000);
    },
  }),
};

describe.each(KINDS)("background_job (%s)", (kind) => {
  backgroundJobContract(harnesses[kind]);
});

/** An effect of `jobId`'s row `row`, written by the job's transaction. */
async function writeEffect(
  tx: JobTransaction,
  jobId: string,
  row: number,
): Promise<void> {
  await tx!.backgroundJob.create({
    data: {
      kind: "ROLLUP_BACKFILL",
      businessId: null,
      payload: { effectOf: jobId, row },
      status: "SUCCEEDED",
    },
  });
}

async function effectsOf(jobId: string): Promise<number[]> {
  const rows = await prisma.$queryRaw<Array<{ row: number }>>`
    SELECT ("payload"->>'row')::int AS "row" FROM "background_job"
    WHERE "payload"->>'effectOf' = ${jobId}
    ORDER BY 1
  `;

  return rows.map((row) => row.row);
}

describe("background_job (prisma only)", () => {
  it("rolls back the effects of an attempt that lost the job, with its refused cursor", async () => {
    await prisma.backgroundJob.deleteMany({});

    const repo = new BackgroundJobRepository(prisma);
    const { job } = await repo.enqueue({
      kind: "SPREADSHEET_IMPORT",
      businessId: A,
      payload: {},
    });
    const claim = () =>
      repo.claim({
        limit: 1,
        owner: "e2e",
        kinds: ["SPREADSHEET_IMPORT"],
        cursor: "",
        maxTenants: 64,
      });

    const [first] = (await claim()).jobs;

    await prisma.$executeRaw`
      UPDATE "background_job" SET "leaseExpiresAt" = now() - interval '1 second'
      WHERE "id" = ${job.id}
    `;

    const [second] = (await claim()).jobs;

    expect(second.attempts).toBe(first.attempts + 1);

    // The old attempt wakes up and writes a row of effects with its cursor.
    await expect(
      prisma.$transaction(async (tx) => {
        await writeEffect(tx, job.id, 1);
        await repo.checkpoint(job.id, first.attempts, { next: 2 }, tx);
      }),
    ).rejects.toBeInstanceOf(JobLeaseLostError);

    expect(await effectsOf(job.id)).toEqual([]);

    // The holder's transaction commits both.
    await prisma.$transaction(async (tx) => {
      await writeEffect(tx, job.id, 1);
      await repo.checkpoint(job.id, second.attempts, { next: 2 }, tx);
    });

    expect(await effectsOf(job.id)).toEqual([1]);
    expect((await repo.findById(job.id))?.progress).toEqual({ next: 2 });
  });

  it("enqueues exactly the cap from twelve uploads at once, over several connections", async () => {
    await prisma.backgroundJob.deleteMany({});

    const clients = [prisma, createPrismaClient(), createPrismaClient()];

    try {
      const outcomes = await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          new BackgroundJobRepository(clients[index % 3]).enqueueWithCap({
            kind: "SPREADSHEET_IMPORT",
            businessId: B,
            subjectId: `upload-${index}`,
            payload: {},
            limit: 3,
          }),
        ),
      );

      expect(
        outcomes.filter((outcome) => outcome.outcome === "enqueued"),
      ).toHaveLength(3);
      expect(
        outcomes.filter((outcome) => outcome.outcome === "busy"),
      ).toHaveLength(9);
      expect(
        await prisma.backgroundJob.count({
          where: { businessId: B, kind: "SPREADSHEET_IMPORT" },
        }),
      ).toBe(3);
    } finally {
      await Promise.all(clients.slice(1).map((client) => client.$disconnect()));
    }
  });

  it("resumes a job whose process was killed from its cursor, every effect once", async () => {
    await prisma.backgroundJob.deleteMany({});

    const repo = new BackgroundJobRepository(prisma);
    const ROWS = 6;

    // Each row's effect and the cursor past it, in one transaction.
    const handler = (killAt: number | null) => ({
      run: async (job: JobContext) => {
        const start = (job.progress as { next: number } | null)?.next ?? 0;

        for (let row = start; row < ROWS; row += 1) {
          // SIGKILL: no stop, no write, the run never ends.
          if (row === killAt) await new Promise(() => undefined);

          await prisma.$transaction(async (tx) => {
            await writeEffect(tx, job.id, row);
            await job.checkpoint({ next: row + 1 }, tx);
          });
        }
      },
    });

    const runner = (killAt: number | null) => {
      const instance = new JobRunner({
        store: repo,
        sweepIntervalMs: 60_000,
        owner: () => (killAt === null ? "survivor" : "killed"),
        renewEveryMs: 60_000,
      });

      instance.register("SPREADSHEET_IMPORT", handler(killAt));

      return instance;
    };

    const { job } = await repo.enqueue({
      kind: "SPREADSHEET_IMPORT",
      businessId: A,
      payload: {},
    });

    void runner(3).processBatch();

    await vi.waitFor(
      async () => expect(await effectsOf(job.id)).toEqual([0, 1, 2]),
      {
        timeout: 10_000,
      },
    );

    // The killed process's lease runs out (two minutes, here at once).
    await prisma.$executeRaw`
      UPDATE "background_job" SET "leaseExpiresAt" = now() - interval '1 second'
      WHERE "id" = ${job.id}
    `;

    expect(await runner(null).processBatch()).toBe(1);

    expect(await effectsOf(job.id)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(await repo.findById(job.id)).toMatchObject({
      status: "SUCCEEDED",
      attempts: 2,
      leaseOwner: "survivor",
      progress: { next: ROWS },
    });
  });

  it("purges only the finished jobs past their retention", async () => {
    await prisma.backgroundJob.deleteMany({});

    const day = 24 * 60 * 60 * 1000;
    const at = (daysAgo: number) => new Date(Date.now() - daysAgo * day);
    const row = (
      status: "SUCCEEDED" | "FAILED" | "CANCELLED" | "PENDING",
      finishedDaysAgo: number | null,
    ) =>
      prisma.backgroundJob.create({
        data: {
          kind: "SPREADSHEET_IMPORT",
          businessId: A,
          status,
          payload: {},
          finished_at: finishedDaysAgo === null ? null : at(finishedDaysAgo),
          ...(status === "PENDING" && { availableAt: at(200) }),
        },
      });

    const kept = await Promise.all([
      row("SUCCEEDED", 29),
      row("FAILED", 89),
      row("CANCELLED", 89),
      row("PENDING", null),
    ]);

    await Promise.all([
      row("SUCCEEDED", 31),
      row("FAILED", 91),
      row("CANCELLED", 91),
    ]);

    const { cleanupBackgroundJobsJob } =
      await import("@/jobs/cron/cleanup-background-jobs-job");

    await cleanupBackgroundJobsJob.handler();

    const left = await prisma.backgroundJob.findMany({ select: { id: true } });

    expect(left.map((each) => each.id).sort()).toEqual(
      kept.map((each) => each.id).sort(),
    );
  });
});
