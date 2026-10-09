import { afterEach, describe, expect, it } from "vitest";

import {
  CRON_TIMEZONE,
  CronSchedulerService,
} from "@/shared/services/cron-scheduler-service";

/**
 * Jobs count in UTC whatever the host says (docs/operacao/jobs.md).
 *
 * node-cron follows the process timezone unless told otherwise, so a
 * "17 3 * * *" purge ran at 03:17 UTC in the container and at 03:17 BRT
 * (06:17 UTC) on a host with TZ=America/Sao_Paulo — and a TZ set on the
 * stack would have moved every nightly job and the partition job's "today".
 */
const originalTz = process.env.TZ;

afterEach(async () => {
  await CronSchedulerService.getInstance().shutdown();

  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

describe("the cron scheduler's clock", () => {
  it("is UTC", () => {
    expect(CRON_TIMEZONE).toBe("Etc/UTC");
  });

  it("fires a nightly job at its UTC hour on a host set to São Paulo", async () => {
    process.env.TZ = "America/Sao_Paulo";

    const scheduler = CronSchedulerService.getInstance();

    scheduler.registerJob({
      name: "timezone-probe",
      schedule: "17 3 * * *",
      handler: async () => undefined,
    });

    await scheduler.initialize();

    const next = scheduler
      .nextRuns()
      .find((entry) => entry.name === "timezone-probe")?.next_run_at;

    expect(next).toBeInstanceOf(Date);
    expect(next!.getUTCHours()).toBe(3);
    expect(next!.getUTCMinutes()).toBe(17);
  });
});
