import { SendWhatsAppProps } from "./whatsapp-queue";
import WhatsAppWorkerManager from "../workers/whatsapp-worker-manage";

class WhatsAppWorkerAdapter {
  private workerManager: WhatsAppWorkerManager;

  constructor() {
    this.workerManager = WhatsAppWorkerManager.getInstance();
  }

  /**
   * Enqueue a WhatsApp message using the worker system
   */
  public async enqueueWhatsApp(
    queueName: string,
    data: SendWhatsAppProps,
  ): Promise<void> {
    try {
      await this.workerManager.enqueueWhatsApp(queueName, data);
    } catch (error) {
      console.error("[WhatsAppWorkerAdapter] Error enqueueing WhatsApp:", error);
      throw error;
    }
  }

  /**
   * Start a worker for a specific queue
   */
  public async startWorker(queueName: string): Promise<void> {
    try {
      await this.workerManager.startWorker(queueName);
    } catch (error) {
      console.error(`[WhatsAppWorkerAdapter] Error starting worker for queue ${queueName}:`, error);
      throw error;
    }
  }

  /**
   * Shutdown all workers
   */
  public async shutdown(): Promise<void> {
    try {
      await this.workerManager.shutdown();
    } catch (error) {
      console.error("[WhatsAppWorkerAdapter] Error during shutdown:", error);
      throw error;
    }
  }
}

export { WhatsAppWorkerAdapter };