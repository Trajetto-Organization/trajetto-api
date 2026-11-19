import { databaseBatch } from "@/../infra/database";
import { env } from "@/env";
import { PartialRunError } from "@/shared/errors/partial-run-error";
import { logger } from "@/shared/logging/logger";
import {
  rollUpTenantDays,
  type TenantDayRollupOptions,
  type TenantDayRollupReport,
} from "@/shared/rollup/tenant-day-rollup";
import { TenantDayRollupRepository } from "@/shared/rollup/tenant-day-rollup-repository";
import { CronJobDefinition } from "@/shared/services/cron-scheduler-service";

import { purgeDeadline } from "./batch-delete";

/**
 * The dashboard's closed days (plano-escala F4-21, decision D52), every 15
 * minutes in the process with the cron: the marks of the days that changed
 * become pending days, each company's closed days due now are counted, in
 * its zone and the platform's, and the history is filled backwards while
 * the run's budget lasts (src/shared/rollup/tenant-day-rollup.ts says how
 * and in what order).
 *
 * On databaseBatch: the counts read months of deliveries on a company's
 * first runs and D−8 to D−1 on every run after, and none of that may take
 * a request's connection. The budget is the purges' one
 * (CRON_PURGE_RUN_BUDGET_MS, half the lease), so a run never lives past
 * its lease beside its own next firing. A run that stops with work left is
 * partial (F1-17): the next firing, 15 minutes later, goes on from there,
 * and 26 h of nothing but partials alerts.
 *
 * Not at the full quarter hours: off the :07 sweep and the :13 statistics,
 * and the first run after midnight in São Paulo (03:00 UTC) closes the
 * platform's day at 03:09.
 */
const TENANT_DAY_ROLLUP_JOB = "tenant-day-rollup";

const log = logger.child({ component: "cron", job: TENANT_DAY_ROLLUP_JOB });

async function runTenantDayRollup(
  options: Partial<TenantDayRollupOptions> = {},
): Promise<TenantDayRollupReport | null> {
  if (!env.TENANT_DAY_ROLLUP_ENABLED) {
    log.debug("tenant day rollup off (TENANT_DAY_ROLLUP_ENABLED=false)");

    return null;
  }

  const report = await rollUpTenantDays({
    repo: new TenantDayRollupRepository(databaseBatch),
    deadline: purgeDeadline(),
    ...options,
  });

  log.info({ ...report }, "tenant days rolled up");

  // Work left: FAILED "[partial]", taken again by the next firing.
  if (report.left.length > 0) throw new PartialRunError(report.left);

  return report;
}

const tenantDayRollupJob: CronJobDefinition = {
  name: TENANT_DAY_ROLLUP_JOB,
  schedule: "9,24,39,54 * * * *",
  handler: async () => {
    await runTenantDayRollup();
  },
};

export { TENANT_DAY_ROLLUP_JOB, runTenantDayRollup, tenantDayRollupJob };
