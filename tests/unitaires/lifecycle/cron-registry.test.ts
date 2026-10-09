import { afterEach, describe, expect, it, vi } from "vitest";

import cron from "node-cron";

import { registerCronJobs } from "@/jobs/cron";
import {
  CronJobDefinition,
  CronSchedulerService,
} from "@/shared/services/cron-scheduler-service";

/**
 * What the replicas actually schedule.
 *
 * A purge that exists as a file but is never registered purges nothing, and
 * no test of the handler would notice: the handler is correct, it just never
 * runs. The webhook ledger was in exactly that state in spirit — its replay
 * window was documented as "respected by the purge" while no purge existed.
 */
afterEach(() => {
  vi.restoreAllMocks();
});

function registered(): CronJobDefinition[] {
  const jobs: CronJobDefinition[] = [];

  vi.spyOn(CronSchedulerService.getInstance(), "registerJob").mockImplementation(
    (definition: CronJobDefinition) => {
      jobs.push(definition);
    },
  );

  registerCronJobs();

  return jobs;
}

describe("the cron registry", () => {
  it("schedules the purge of the webhook ledger", () => {
    const job = registered().find(
      (entry) => entry.name === "cleanup-webhook-deliveries",
    );

    expect(job).toBeDefined();
    expect(cron.validate(job!.schedule)).toBe(true);
  });

  it("gives every job a unique name and a valid schedule", () => {
    const jobs = registered();

    // A duplicate name is silently ignored by the scheduler, so a copy-paste
    // would drop the second job without a word.
    expect(new Set(jobs.map((job) => job.name)).size).toBe(jobs.length);

    for (const job of jobs) {
      expect(cron.validate(job.schedule), job.name).toBe(true);
    }
  });
});
