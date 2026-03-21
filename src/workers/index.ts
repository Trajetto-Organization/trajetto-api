import EmailWorkerService from "../shared/services/email-worker-service";
import WhatsAppWorkerService from "../shared/services/whatsapp-worker-service";

import AIVerificationWorkerService from "../shared/services/ai-verification-worker-service";

import { CronSchedulerService } from "../shared/services/cron-scheduler-service";
import { registerCronJobs } from "../jobs/cron";

/**
 * Initializes the worker system and other related services
 */
export async function initializeWorkers(): Promise<void> {
  try {
    // Register and initialize cron jobs
    registerCronJobs();
    await CronSchedulerService.getInstance().initialize();

    // Initialize services in parallel for better performance
    await Promise.all([
      EmailWorkerService.getInstance().initialize(),
      WhatsAppWorkerService.getInstance().initialize(),
      AIVerificationWorkerService.getInstance().initialize(),
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
      EmailWorkerService.getInstance().shutdown(),
      WhatsAppWorkerService.getInstance().shutdown(),
      AIVerificationWorkerService.getInstance().shutdown(),
      CronSchedulerService.getInstance().shutdown(),
    ]);

    console.log("[WorkerSystem] Sistema de workers encerrado com sucesso");
  } catch (error) {
    console.error("[WorkerSystem] Erro ao encerrar workers:", error);
    throw error;
  }
}
