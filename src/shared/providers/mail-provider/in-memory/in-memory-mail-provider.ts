import {
  MailProviderProps,
  MailSendResult,
} from "../dtos/mail-provider-dto";
import { IMailProvider } from "../IMail-provider";

import { buildMessageId } from "../message-id";

class InMemoryMailProvider implements IMailProvider {
  private message: any[] = [];

  async sendMail({
    to,
    subject,
    variables,
    path,
    referenceId,
  }: MailProviderProps): Promise<MailSendResult> {
    // Mirrors the real providers: the same reference always produces the same
    // message identity, so a test can assert that a redelivery is recognised
    // as the same message rather than a new one.
    const messageId = referenceId
      ? buildMessageId(referenceId, "intrajetto.com")
      : undefined;

    this.message.push({
      to,
      subject,
      variables,
      path,
      referenceId,
      messageId,
    });

    return { messageId };
  }
}

export { InMemoryMailProvider };
