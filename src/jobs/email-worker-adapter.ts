import EmailWorkerService from "../shared/services/email-worker-service";
import { SendEmailProps } from "./email-queue";

/**
 * Adapts the EmailQueueProvider API to use worker threads
 */
class EmailWorkerAdapter {
  private queueName: string;
  private emailService: EmailWorkerService;

  constructor(queueName: string = "emailQueue") {
    this.queueName = queueName;
    this.emailService = EmailWorkerService.getInstance();
  }

  async enqueueEmail(emailProps: SendEmailProps): Promise<void> {
    await this.emailService.enqueueEmail(this.queueName, emailProps);
  }

  // Empty method for compatibility with existing API
  async close(): Promise<void> {
    // Nothing to do here - termination is managed centrally
  }
}

export { EmailWorkerAdapter };
