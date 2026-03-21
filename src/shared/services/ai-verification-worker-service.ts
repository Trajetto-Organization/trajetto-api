import AIVerificationWorkerManager from "../../workers/ai-verification-worker-manage";

import { AIVerificationJobData } from "../../jobs/ai-verification-queue";
import { sendAIVerificationEvent } from "../../websocket";

class AIVerificationWorkerService {
  private static instance: AIVerificationWorkerService;
  private workerManager: AIVerificationWorkerManager;

  private constructor() {
    this.workerManager = AIVerificationWorkerManager.getInstance();

    // Set up WebSocket relay: when worker sends a WS event via IPC,
    // the manager relays it here, and we emit it through Socket.IO
    this.workerManager.onWebSocketRelay = (userId: string, event: any) => {
      sendAIVerificationEvent(userId, event);
    };
  }

  public static getInstance(): AIVerificationWorkerService {
    if (!AIVerificationWorkerService.instance) {
      AIVerificationWorkerService.instance = new AIVerificationWorkerService();
    }

    return AIVerificationWorkerService.instance;
  }

  public async initialize(): Promise<void> {
    console.log(
      "[AIVerificationWorkerService] Inicializando serviço de verificação IA",
    );
  }

  public async enqueueVerification(data: AIVerificationJobData): Promise<void> {
    try {
      await this.workerManager.enqueueVerification("aiVerificationQueue", data);
    } catch (error) {
      console.error(
        `[AIVerificationWorkerService] Erro ao enfileirar verificação:`,
        error,
      );

      throw error;
    }
  }

  public async shutdown(): Promise<void> {
    await this.workerManager.shutdown();
  }
}

export default AIVerificationWorkerService;
