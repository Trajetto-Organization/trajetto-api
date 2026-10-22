import { afterEach, describe, expect, it, vi } from "vitest";

import cron from "node-cron";

import { registerCronJobs } from "@/jobs/cron";
import {
  CronJobDefinition,
  CronSchedulerService,
} from "@/shared/services/cron-scheduler-service";

/**
 * The two sweeps that close what a dead process leaves open.
 *
 * A sweep that exists as a file but is never registered sweeps nothing, and
 * its own E2E test would still pass: the handler is correct, it just never
 * runs. Same reasoning as cron-registry.test.ts.
 */
afterEach(() => {
  vi.restoreAllMocks();
});

function registered(): CronJobDefinition[] {
  const jobs: CronJobDefinition[] = [];

  vi.spyOn(
    CronSchedulerService.getInstance(),
    "registerJob",
  ).mockImplementation((definition: CronJobDefinition) => {
    jobs.push(definition);
  });

  registerCronJobs();

  return jobs;
}

describe("the idempotency sweeps", () => {
  it.each([
    // A proof's AI reading whose post-commit request was lost (IDEMP-08).
    "reconcile-proof-analysis",
    // An upload left IN_PROGRESS by a process that died (IDEMP-10).
    "close-abandoned-imports",
  ])("%s is scheduled", (name) => {
    const job = registered().find((entry) => entry.name === name);

    expect(job).toBeDefined();
    expect(cron.validate(job!.schedule)).toBe(true);
  });
});
