import { MailProviderProps, MailSendResult } from "./dtos/mail-provider-dto";

interface IMailProvider {
  /**
   * Sends the message and resolves only when the transport accepted it.
   * Any failure throws a MailDeliveryError — the notification pipeline uses
   * its `retryable` flag to choose between backoff and permanent failure.
   */
  sendMail: ({
    to,
    subject,
    variables,
    path,
    referenceId,
  }: MailProviderProps) => Promise<MailSendResult>;
}

export { IMailProvider };
