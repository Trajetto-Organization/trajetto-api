import database from "@/../infra/database";
import { CronJobDefinition } from "@/shared/services/cron-scheduler-service";

/**
 * Resets the AI ​​usage counter (ai_analysis_used) for all companies.
 * on the first day of each month at midnight.
 *
 * Cron: "0 0 1 * *" → 00:00 on the 1st of each month
 */
const resetAIUsageJob: CronJobDefinition = {
  name: "reset-ai-usage",
  schedule: "0 0 1 * *",

  async handler() {
    const result = await database.business.updateMany({
      where: {
        ai_analysis_used: { gt: 0 },
      },
      data: {
        ai_analysis_used: 0,
        ai_analysis_reset_at: new Date(),
      },
    });

    console.log(
      `[ResetAIUsage] ${result.count} empresa(s) tiveram o contador de IA resetado`,
    );
  },
};

export { resetAIUsageJob };
