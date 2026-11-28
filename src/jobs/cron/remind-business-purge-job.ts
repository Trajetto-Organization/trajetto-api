import { CronJobDefinition } from "@/shared/services/cron-scheduler-service";
import { logger } from "@/shared/logging/logger";

import { BusinessRepository } from "@/modules/business/repositories/business-repository";
import { UserRepository } from "@/modules/user/repositories/user-repository";
import { mailBusinessPurge } from "@/modules/business/services/business-purge-mail";

const log = logger.child({ component: "cron", job: "remind-business-purge" });

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The second e-mail of a scheduled purge (plano-escala F3-25): 7 days
 * before a company's data goes, its administrators are reminded, while a
 * MASTER can still reactivate it.
 *
 * Once a day, for the companies whose purge falls between 6 and 7 days
 * after the run's elected minute: consecutive runs cover consecutive days,
 * so each company is reminded once, and a run the catch-up redoes reads
 * the same window from the same minute.
 *
 * Cron: "0 12 * * *" → daily at 12:00 UTC (09:00 in Brasília).
 */
const remindBusinessPurgeJob: CronJobDefinition = {
  name: "remind-business-purge",
  schedule: "0 12 * * *",

  async handler(run) {
    const at = (run?.scheduledFor ?? new Date()).getTime();
    const due = await new BusinessRepository().findScheduledPurges(
      new Date(at + 6 * DAY_MS),
      new Date(at + 7 * DAY_MS),
    );

    const users = new UserRepository();
    let reminded = 0;

    for (const business of due) {
      reminded += await mailBusinessPurge("reminder", business, users);
    }

    if (due.length > 0) {
      log.info(
        { companies: due.length, administrators: reminded },
        "administrators reminded of a purge 7 days ahead",
      );
    }
  },
};

export { remindBusinessPurgeJob };
