import { CronSchedulerService } from "@/shared/services/cron-scheduler-service";

import { cleanupExpiredRefreshTokensJob } from "./cleanup-expired-refresh-tokens-job";
import { cleanupNotificationPipelineJob } from "./cleanup-notification-pipeline-job";

import { cleanupAIPipelineJob } from "./cleanup-ai-pipeline-job";
import { cleanupUserHistoryJob } from "./cleanup-user-history-job";
import { driverPositionPartitionsJob } from "./driver-position-partitions-job";
import { cleanupOrphanUploadsJob } from "./cleanup-orphan-uploads-job";
import { checkPushReceiptsJob } from "./check-push-receipts-job";
import { cleanupWebhookDeliveriesJob } from "./cleanup-webhook-deliveries-job";
import { cleanupApiUsageJob } from "./cleanup-api-usage-job";
import { opsHeartbeatJob } from "./ops-heartbeat-job";
import { reconcileProofAnalysisJob } from "./reconcile-proof-analysis-job";
import { closeAbandonedImportsJob } from "./close-abandoned-imports-job";
import { escalateOccurrenceAuthorizationsJob } from "./escalate-occurrence-authorizations-job";
import { repairUnticketedMessagesJob } from "./repair-unticketed-messages-job";

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

  // Settled webhook rows past the replay window (+1 day of grace).
  scheduler.registerJob(cleanupWebhookDeliveriesJob);

  // API usage counts past 400 days (the screen reads 90): the table had no
  // bound at all (db-perf 10/2026).
  scheduler.registerJob(cleanupApiUsageJob);

  // Both halves of one invariant: a partition for every day we care
  // about. A missing one is not a warning — the insert is refused.
  scheduler.registerJob(driverPositionPartitionsJob);

  // Dry-run unless UPLOAD_ORPHAN_GC says otherwise: counts stored objects
  // that never became a row, and removes them only when switched on.
  scheduler.registerJob(cleanupOrphanUploadsJob);

  // Expo tickets → receipts: FCM/APNs' verdict on each push, and the dead
  // devices only a receipt reveals.
  scheduler.registerJob(checkPushReceiptsJob);

  // Every minute: the operational rules, pushed to the external dead man's
  // switch (HEALTHCHECK_PING_URL). Its silence is the alert (OBS-03).
  scheduler.registerJob(opsHeartbeatJob);

  // Every 10 minutes: a proof's AI reading whose post-commit request was
  // lost is asked for again (IDEMP-08).
  scheduler.registerJob(reconcileProofAnalysisJob);

  // Every 5 minutes: an upload left IN_PROGRESS by a dead process is closed
  // so the undo can take it back (IDEMP-10).
  scheduler.registerJob(closeAbandonedImportsJob);

  // Every minute: a driver's occurrence the tower has not answered in ten
  // minutes goes to the administrators, once (decision 6.3).
  scheduler.registerJob(escalateOccurrenceAuthorizationsJob);

  // Every minute, during the ticket rollout: messages the previous image
  // wrote without a ticket are filed (decision 14.5, design §9.3).
  scheduler.registerJob(repairUnticketedMessagesJob);
}

export { registerCronJobs };
