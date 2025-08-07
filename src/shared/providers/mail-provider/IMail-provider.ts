import { MailProviderProps } from "./dtos/mail-provider-dto";

interface IMailProvider {
  sendMail: ({
    to,
    subject,
    variables,
    path,
  }: MailProviderProps) => Promise<void>;
}

export { IMailProvider };
