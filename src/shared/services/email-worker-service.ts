import EmailWorkerManager from "../../workers/email-worker-manage";
import { SendEmailProps } from "../../jobs/email-queue";

class EmailWorkerService {
  private static instance: EmailWorkerService;
  private workerManager: EmailWorkerManager;

  private constructor() {
    this.workerManager = EmailWorkerManager.getInstance();
  }

  public static getInstance(): EmailWorkerService {
    if (!EmailWorkerService.instance) {
      EmailWorkerService.instance = new EmailWorkerService();
    }
    return EmailWorkerService.instance;
  }

  public async initialize(): Promise<void> {
    // We can pre-initialize known queues here
    console.log("[EmailWorkerService] Inicializando serviço de emails");
  }

  public async enqueueEmail(
    queueName: string,
    emailProps: SendEmailProps,
  ): Promise<void> {
    try {
      await this.workerManager.enqueueEmail(queueName, emailProps);
    } catch (error) {
      console.error(
        `[EmailWorkerService] Erro ao enfileirar email para ${queueName}:`,
        error,
      );
      throw error;
    }
  }

  public async shutdown(): Promise<void> {
    await this.workerManager.shutdown();
  }
}

export default EmailWorkerService;
