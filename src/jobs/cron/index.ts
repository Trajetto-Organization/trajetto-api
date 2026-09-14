import { CronSchedulerService } from "@/shared/services/cron-scheduler-service";

import { cleanupExpiredRefreshTokensJob } from "./cleanup-expired-refresh-tokens-job";
import { cleanupNotificationPipelineJob } from "./cleanup-notification-pipeline-job";

import { cleanupAIPipelineJob } from "./cleanup-ai-pipeline-job";
import { cleanupUserHistoryJob } from "./cleanup-user-history-job";

/**
 * It records all the application's cron jobs.
 *
 * To add a new job, create the file in src/jobs/cron/
 * and register here.
 */
function registerCronJobs(): void {
  const scheduler = CronSchedulerService.getInstance();

  scheduler.registerJob(cleanupExpiredRefreshTokensJob);
  scheduler.registerJob(cleanupNotificationPipelineJob);

  scheduler.registerJob(cleanupAIPipelineJob);
  scheduler.registerJob(cleanupUserHistoryJob);
}

export { registerCronJobs };
