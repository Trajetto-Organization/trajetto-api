import { CronSchedulerService } from "../shared/services/cron-scheduler-service";
import { NotificationPipelineService } from "../shared/notifications/notification-pipeline-service";

import { AIAnalysisPipelineService } from "../shared/ai/ai-analysis-pipeline-service";
import { WebhookDispatchService } from "../shared/integration/webhook-dispatch-service";
import { apiUsageRecorder } from "../shared/integration/api-usage-recorder";

import { registerCronJobs } from "../jobs/cron";

/**
 * Initializes the worker system and other related services
 */
export async function initializeWorkers(): Promise<void> {
  try {
    // Register and initialize cron jobs
    registerCronJobs();
    await CronSchedulerService.getInstance().initialize();

    // Synchronous: it only starts a timer, and starting it after the HTTP
    // server is already answering would drop the first ten seconds of counts.
    apiUsageRecorder.initialize();

    // Initialize services in parallel for better performance
    await Promise.all([
      NotificationPipelineService.getInstance().initialize(),
      AIAnalysisPipelineService.getInstance().initialize(),
      WebhookDispatchService.getInstance().initialize(),
    ]);

    console.log("[WorkerSystem] Sistema de workers inicializado com sucesso");
  } catch (error) {
    console.error("[WorkerSystem] Erro ao inicializar workers:", error);
    throw error;
  }
}

/**
 * Terminates all workers
 */
export async function shutdownWorkers(): Promise<void> {
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

    console.log("[WorkerSystem] Sistema de workers encerrado com sucesso");
  } catch (error) {
    console.error("[WorkerSystem] Erro ao encerrar workers:", error);
    throw error;
  }
}
