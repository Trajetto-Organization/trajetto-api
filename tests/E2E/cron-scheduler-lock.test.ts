import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import type { CronJobDefinition } from "@/shared/services/cron-scheduler-service";

/**
 * The cron election, against Postgres.
 *
 * Every replica's node-cron fires every job; the unique
 * (jobName, scheduledFor) insert decides which one runs it. That election had
 * no test at all — the matrix called it "teste de lock" — so a replica that
 * lost the insert and ran the job anyway (what the old takeover did without
 * its lease check) left the whole suite green. The takeover is gone (GAP6-9):
 * a run that died is recovered by the catch-up sweep, tested in
 * cron-catch-up.test.ts, and never by a second claim of the same slot.
 *
 * Two scheduler instances stand in for two replicas: the election lives
 * entirely in the database, and two instances on the pool race the same
 * insert that two processes would.
 */
const prisma = new PrismaClient();

type Scheduler = {
  claimExecution(jobName: string, scheduledFor: Date): Promise<boolean>;
  runExclusively(definition: CronJobDefinition): Promise<void>;
};

let replicaA: Scheduler;
let replicaB: Scheduler;

beforeAll(async () => {
  const { CronSchedulerService } = await import(
    "@/shared/services/cron-scheduler-service"
  );

  // The constructor is private (production uses one per process); the test
  // needs two, and the private methods are the election itself.
  const Constructor = CronSchedulerService as unknown as new () => Scheduler;

  replicaA = new Constructor();
  replicaB = new Constructor();
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
});

/** A slot nobody else in this file uses, truncated like the scheduler does. */
function slot(): Date {
  const scheduledFor = new Date(
    Date.UTC(2026, 0, 1, 0, 0, 0) + Math.floor(Math.random() * 1e9) * 60_000,
  );

  scheduledFor.setSeconds(0, 0);

  return scheduledFor;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("two replicas firing the same job in the same minute", () => {
  it("elect exactly one of them", async () => {
    for (let round = 0; round < 10; round += 1) {
      const jobName = `lock-${randomUUID()}`;
      const scheduledFor = slot();

      const won = await Promise.all([
        replicaA.claimExecution(jobName, scheduledFor),
        replicaB.claimExecution(jobName, scheduledFor),
      ]);

      expect(
        won.filter(Boolean),
        `rodada ${round}: ${JSON.stringify(won)}`,
      ).toHaveLength(1);
    }
  });

  it(
    "run the handler once, and the run is recorded as it ended",
    { timeout: 90_000 },
    async () => {
      // runExclusively truncates "now" to the minute; both calls must fall in
      // the same one, or they are two firings and both SHOULD run.
      const seconds = new Date().getSeconds();
      if (seconds > 50) await sleep((61 - seconds) * 1000);

      let runs = 0;

      const definition: CronJobDefinition = {
        name: `lock-${randomUUID()}`,
        schedule: "* * * * *",
        handler: async () => {
          runs += 1;

          // Long enough that the loser's attempt lands while the winner is
          // still running — the moment a second claim of the slot would let
          // it in.
          await sleep(2_000);
        },
      };

      await Promise.all([
        replicaA.runExclusively(definition),
        replicaB.runExclusively(definition),
      ]);

      expect(runs).toBe(1);

      const rows = await prisma.scheduledJobExecution.findMany({
        where: { jobName: definition.name },
      });

      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("SUCCEEDED");
      expect(rows[0].finishedAt).not.toBeNull();
    },
  );
});

describe("a firing another replica already holds", () => {
  it("is not taken over while the holder's lease is alive", async () => {
    const jobName = `lock-${randomUUID()}`;
    const scheduledFor = slot();

    // The winner is mid-run, well inside its lease.
    await prisma.scheduledJobExecution.create({
      data: {
        jobName,
        scheduledFor,
        leaseExpiresAt: new Date(Date.now() + 5 * 60_000),
      },
    });

    expect(await replicaB.claimExecution(jobName, scheduledFor)).toBe(false);

    const row = await prisma.scheduledJobExecution.findUniqueOrThrow({
      where: { jobName_scheduledFor: { jobName, scheduledFor } },
    });

    expect(row.status).toBe("RUNNING");
    expect(row.attempts).toBe(1);
  });

  it("is not run again once it finished, successfully or not", async () => {
    for (const status of ["SUCCEEDED", "FAILED"] as const) {
      const jobName = `lock-${randomUUID()}`;
      const scheduledFor = slot();

      await prisma.scheduledJobExecution.create({
        data: {
          jobName,
          scheduledFor,
          status,
          finishedAt: new Date(),
          // Long past: only RUNNING rows are ever eligible, whatever the
          // lease says.
          leaseExpiresAt: new Date(Date.now() - 60 * 60_000),
        },
      });

      expect(await replicaA.claimExecution(jobName, scheduledFor), status).toBe(
        false,
      );
    }
  });
});
