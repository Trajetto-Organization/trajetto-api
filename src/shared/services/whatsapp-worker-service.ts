import WhatsAppWorkerManager from "../../workers/whatsapp-worker-manage";
import { SendWhatsAppProps } from "../../jobs/whatsapp-queue";

class WhatsAppWorkerService {
  private static instance: WhatsAppWorkerService;
  private workerManager: WhatsAppWorkerManager;

  private constructor() {
    this.workerManager = WhatsAppWorkerManager.getInstance();
  }

  public static getInstance(): WhatsAppWorkerService {
    if (!WhatsAppWorkerService.instance) {
      WhatsAppWorkerService.instance = new WhatsAppWorkerService();
    }

    return WhatsAppWorkerService.instance;
  }

  public async initialize(): Promise<void> {
    console.log("[WhatsAppWorkerService] Inicializando serviço de WhatsApp");
  }

  public async enqueueWhatsApp(
    queueName: string,
    whatsAppProps: SendWhatsAppProps,
  ): Promise<void> {
    try {
      await this.workerManager.enqueueWhatsApp(queueName, whatsAppProps);
    } catch (error) {
      console.error(
        `[WhatsAppWorkerService] Erro ao enfileirar WhatsApp para ${queueName}:`,
        error,
      );

      throw error;
    }
  }

  public async shutdown(): Promise<void> {
    await this.workerManager.shutdown();
  }
}

export default WhatsAppWorkerService;
export { WhatsAppWorkerService };
