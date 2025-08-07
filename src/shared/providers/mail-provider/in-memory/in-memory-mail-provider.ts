import { MailProviderProps } from "../dtos/mail-provider-dto";
import { IMailProvider } from "../IMail-provider";

class InMemoryMailProvider implements IMailProvider {
  private message: any[] = [];

  async sendMail({
    to,
    subject,
    variables,
    path,
  }: MailProviderProps): Promise<void> {
    this.message.push({
      to,
      subject,
      variables,
      path,
    });
  }
}

export { InMemoryMailProvider };
