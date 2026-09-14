import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { container } from "tsyringe";

import { IMailProvider } from "../providers/mail-provider/IMail-provider";

interface SendTransactionalMailProps {
  email: string;
  name?: string;
  subject: string;
  templateName: string;
  moduleName: string;
  additionalVariablesProperties?: Record<string, any>;
}

/**
 * Transactional e-mails (credentials, password reset, 2FA) that are triggered
 * straight from a use case and have no notification topic behind them.
 *
 * They are sent in-process: the RabbitMQ hop was removed and these messages
 * carry secrets (plain passwords, one-time codes) that must never sit in a
 * persisted outbox payload, so they cannot ride the notification pipeline
 * either. The call throws a MailDeliveryError on failure — callers decide
 * whether that aborts the use case or is only logged.
 */
async function sendTransactionalMail({
  email,
  name,
  subject,
  templateName,
  moduleName,
  additionalVariablesProperties,
}: SendTransactionalMailProps): Promise<void> {
  // Templates live next to their module both in dev (src/) and in the image,
  // where the build copies build/src/modules back to ./src/modules.
  const templatePath = resolve(
    process.cwd(),
    "src",
    "modules",
    moduleName,
    "views",
    templateName,
  );

  const [firstName] = name?.split(" ") ?? ["Usuário"];
  const currentYear = new Date().getFullYear();

  const mailProvider = container.resolve<IMailProvider>("MailProvider");

  await mailProvider.sendMail({
    to: email,
    subject,
    path: templatePath,
    variables: {
      name: firstName,
      year: currentYear,
      ...additionalVariablesProperties,
    },
    referenceId: randomUUID(),
  });
}

export { sendTransactionalMail, SendTransactionalMailProps };
