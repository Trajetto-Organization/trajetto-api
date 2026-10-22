import { MailProviderProps, MailSendResult } from "../dtos/mail-provider-dto";
import { IMailProvider } from "../IMail-provider";

import nodemailer, { Transporter } from "nodemailer";

import { logger } from "@/shared/logging/logger";

import { renderMailTemplate } from "../template-renderer";
import { toMailDeliveryError } from "../errors/mail-delivery-error";
import { buildMessageId } from "../message-id";

const log = logger.child({ component: "mail-provider", provider: "ethereal" });

const SMTP_TIMEOUT_MS = 10_000;

class EtherealMailProvider implements IMailProvider {
  private client?: Transporter;

  private initializationPromise?: Promise<Transporter>;

  private async getClient(): Promise<Transporter> {
    if (this.client) return this.client;

    // The promise is not cached across failures on purpose: a test account
    // that could not be created must be retried on the next send instead of
    // poisoning the provider until the process restarts.
    if (!this.initializationPromise) {
      this.initializationPromise = (async () => {
        const account = await nodemailer.createTestAccount();

        const transporter = nodemailer.createTransport({
          host: account.smtp.host,
          port: account.smtp.port,
          secure: account.smtp.secure,
          auth: {
            user: account.user,
            pass: account.pass,
          },
          pool: true,
          maxConnections: 3,
          connectionTimeout: SMTP_TIMEOUT_MS,
          greetingTimeout: SMTP_TIMEOUT_MS,
          socketTimeout: SMTP_TIMEOUT_MS,
        });

        this.client = transporter;
        return transporter;
      })().catch((error) => {
        this.initializationPromise = undefined;
        throw error;
      });
    }

    return this.initializationPromise;
  }

  async sendMail({
    to,
    subject,
    variables,
    path,
    referenceId,
  }: MailProviderProps): Promise<MailSendResult> {
    const templateHTML = renderMailTemplate(path, variables);

    try {
      const client = await this.getClient();

      const message = await client.sendMail({
        to,
        from: "Trajetto <noreply@intrajetto.com>",
        subject,
        html: templateHTML,
        // Same deterministic identity as production, so the dev path
        // exercises the behaviour rather than diverging from it.
        ...(referenceId
          ? {
              messageId: buildMessageId(referenceId, "intrajetto.com"),
            }
          : {}),

        headers: {
          ...(referenceId ? { "X-Entity-Ref-ID": referenceId } : {}),
          "X-Mailer": "Trajetto Fleet Management System",
        },
      });

      // Dev-only affordance: without the preview link the message is
      // unreachable, since Ethereal never delivers anywhere.
      log.info(
        {
          previewUrl: nodemailer.getTestMessageUrl(message) || null,
          referenceId,
        },
        "e-mail captured by Ethereal",
      );

      return { messageId: message.messageId };
    } catch (error) {
      // No recipient in the text (OBS-15), as in the production provider.
      const deliveryError = toMailDeliveryError(
        error,
        "Falha ao enviar e-mail",
      );

      log.error(
        { err: deliveryError, retryable: deliveryError.retryable, referenceId },
        "e-mail send failed",
      );

      throw deliveryError;
    }
  }
}

export { EtherealMailProvider };
