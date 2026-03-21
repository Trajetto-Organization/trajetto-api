import { CronSchedulerService } from "@/shared/services/cron-scheduler-service";
import { resetAIUsageJob } from "./reset-ai-usage-job";

/**
 * It records all the application's cron jobs.
 *
 * To add a new job, create the file in src/jobs/cron/
 * and register here.
 */
function registerCronJobs(): void {
  const scheduler = CronSchedulerService.getInstance();
  scheduler.registerJob(resetAIUsageJob);
}

export { registerCronJobs };
