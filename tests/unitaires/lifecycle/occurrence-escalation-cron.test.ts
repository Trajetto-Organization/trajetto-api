import { afterEach, expect, it, vi } from "vitest";

import { registerCronJobs } from "@/jobs/cron";
import {
  CronJobDefinition,
  CronSchedulerService,
} from "@/shared/services/cron-scheduler-service";

/**
 * The escalation of an unanswered authorization (decision 6.3) only happens
 * if a replica schedules it: a correct handler that is never registered
 * escalates nothing, and no test of the handler would notice.
 */
afterEach(() => {
  vi.restoreAllMocks();
});

it("schedules the escalation every minute, quietly", () => {
  const jobs: CronJobDefinition[] = [];

  vi.spyOn(
    CronSchedulerService.getInstance(),
    "registerJob",
  ).mockImplementation((definition: CronJobDefinition) => {
    jobs.push(definition);
  });

  registerCronJobs();

  expect(
    jobs.find((job) => job.name === "escalate-occurrence-authorizations"),
  ).toMatchObject({
    schedule: "* * * * *",
    quiet: true,
  });
});

// Plan of 02/11/2026, K11 (D26): the warning about a route left open only
// happens if a replica schedules it — same reason as the escalation above.
it("schedules the sweep of routes left open hourly, quietly", () => {
  const jobs: CronJobDefinition[] = [];

  vi.spyOn(
    CronSchedulerService.getInstance(),
    "registerJob",
  ).mockImplementation((definition: CronJobDefinition) => {
    jobs.push(definition);
  });

  registerCronJobs();

  expect(
    jobs.find((job) => job.name === "alert-routes-left-open"),
  ).toMatchObject({
    schedule: "7 * * * *",
    quiet: true,
  });
});
