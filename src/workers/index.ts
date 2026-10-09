import { CronSchedulerService } from "../shared/services/cron-scheduler-service";
import { NotificationPipelineService } from "../shared/notifications/notification-pipeline-service";

import { AIAnalysisPipelineService } from "../shared/ai/ai-analysis-pipeline-service";
import { WebhookDispatchService } from "../shared/integration/webhook-dispatch-service";
import { apiUsageRecorder } from "../shared/integration/api-usage-recorder";

import { registerCronJobs } from "../jobs/cron";
import { env } from "../env";
import { logger } from "../shared/logging/logger";
import { startHeartbeatFlush } from "../shared/health/worker-heartbeat";

const log = logger.child({ component: "workers" });

/** Stops the periodic write of this replica's worker heartbeats (OBS-10). */
let stopHeartbeatFlush: (() => void) | null = null;

/**
 * Initializes the worker system and other related services
 */
export async function initializeWorkers(): Promise<void> {
  try {
    // Synchronous: it only starts a timer, and starting it after the HTTP
    // server is already answering would drop the first ten seconds of counts.
    // Started whatever the replica's role: it is fed by the integration API's
    // HTTP requests, so it runs wherever those are served.
    apiUsageRecorder.initialize();

    // An HTTP-only replica (GAP2-3): no cron, no pipeline timers, and its
    // publishes do not drain — the worker service's sweep picks them up.
    // Socket.IO still starts here (server.ts), so a worker-only replica of
    // the same image keeps reaching every client through the Redis adapter.
    if (!env.WORKERS_ENABLED) {
      log.info("workers disabled on this replica (WORKERS_ENABLED=false)");
      return;
    }

    // Register and initialize cron jobs
    registerCronJobs();
    await CronSchedulerService.getInstance().initialize();

    // Initialize services in parallel for better performance
    await Promise.all([
      NotificationPipelineService.getInstance().initialize(),
      AIAnalysisPipelineService.getInstance().initialize(),
      WebhookDispatchService.getInstance().initialize(),
    ]);

    // Every replica writes where its workers were last seen, so a cycle hung
    // on one replica shows on /health/metrics whichever replica answers.
    stopHeartbeatFlush = startHeartbeatFlush();

    log.info("workers started");
  } catch (error) {
    log.error({ err: error }, "workers could not be started");
    throw error;
  }
}

/**
 * Drains what accumulated while the replica was down. Called by the boot
 * AFTER Socket.IO is up (shared/lifecycle/startup.ts): the two pipelines emit
 * to sockets, and a drain before realtime existed delivered the whole backlog
 * with no toast (OUTBOX-19). The webhook dispatcher emits nothing to sockets
 * and keeps its immediate drain in initialize().
 */
export function drainWorkerBacklog(): void {
  if (!env.WORKERS_ENABLED) return;

  NotificationPipelineService.getInstance().wake();
  AIAnalysisPipelineService.getInstance().wake();
}

/**
 * Terminates all workers
 */
export async function shutdownWorkers(): Promise<void> {
  // The rows age out of /health/metrics on their own once this replica stops
  // writing them; nothing to flush on the way out.
  stopHeartbeatFlush?.();
  stopHeartbeatFlush = null;

  try {
    // Shutdown services in parallel for better performance
    await Promise.all([
      NotificationPipelineService.getInstance().shutdown(),
      AIAnalysisPipelineService.getInstance().shutdown(),
      WebhookDispatchService.getInstance().shutdown(),
      CronSchedulerService.getInstance().shutdown(),

      // Writes what it is holding on the way out — the batch most likely to
      // be the one somebody asks about right after a deploy.
      apiUsageRecorder.shutdown(),
    ]);

    log.info("workers stopped");
  } catch (error) {
    log.error({ err: error }, "workers could not be stopped");
    throw error;
  }
}
