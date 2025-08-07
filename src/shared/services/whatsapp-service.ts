import WhatsAppWorkerService from "./whatsapp-worker-service";

interface SendWhatsAppNotificationProps {
  instanceName: string;
  phoneNumber: string;
  message: string;
  userId?: string;
}

class WhatsAppService {
  private static instance: WhatsAppService;
  private whatsAppWorkerService: WhatsAppWorkerService;

  private constructor() {
    this.whatsAppWorkerService = WhatsAppWorkerService.getInstance();
  }

  public static getInstance(): WhatsAppService {
    if (!WhatsAppService.instance) {
      WhatsAppService.instance = new WhatsAppService();
    }
    return WhatsAppService.instance;
  }

  /**
   * Enqueue WhatsApp message for background processing
   */
  public async enqueueWhatsAppMessage(
    queueName: string,
    data: SendWhatsAppNotificationProps,
  ): Promise<void> {
    try {
      await this.whatsAppWorkerService.enqueueWhatsApp(queueName, data);
      console.log(`[WhatsAppService] Successfully enqueued WhatsApp message to ${data.phoneNumber}`);
    } catch (error) {
      console.error("[WhatsAppService] Error enqueueing WhatsApp message:", error);
      // Don't throw error to prevent blocking the main operation
    }
  }
}

export { WhatsAppService, SendWhatsAppNotificationProps };