import {
  MailProviderProps,
  MailSendResult,
} from "../dtos/mail-provider-dto";
import { IMailProvider } from "../IMail-provider";

import nodemailer, { Transporter } from "nodemailer";

import { env } from "@/env";
import { renderMailTemplate } from "../template-renderer";

import { toMailDeliveryError } from "../errors/mail-delivery-error";
import { buildMessageId, senderDomain } from "../message-id";

/**
 * Every timeout is bounded because sending now happens inside the
 * notification pipeline worker: an SMTP server that accepts the TCP
 * connection and then goes silent would otherwise hold a delivery slot (and
 * its lease) open indefinitely.
 */
const SMTP_TIMEOUT_MS = 10_000;

class ResendMailProvider implements IMailProvider {
  private client: Transporter;

  constructor() {
    this.client = nodemailer.createTransport({
      host: "smtp.resend.com",
      port: 587, // STARTTLS
      auth: {
        user: "resend",
        pass: env.RESEND_SECRET_KEY,
      },
      // The pipeline sends in-process and in batches; pooling reuses the
      // authenticated SMTP connection instead of handshaking per message.
      pool: true,
      maxConnections: 3,
      connectionTimeout: SMTP_TIMEOUT_MS,
      greetingTimeout: SMTP_TIMEOUT_MS,
      socketTimeout: SMTP_TIMEOUT_MS,
    });
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
      const info = await this.client.sendMail({
        to,
        from: env.RESEND_FROM_EMAIL,
        subject,
        html: templateHTML,

        // Deterministic, so a redelivery of the same notification carries the
        // same message identity and most receivers suppress the copy. See
        // message-id.ts for what this does and does not guarantee.
        ...(referenceId
          ? {
              messageId: buildMessageId(
                referenceId,
                senderDomain(env.RESEND_FROM_EMAIL),
              ),
            }
          : {}),

        headers: {
          // Only sent when the caller supplied one: a constant here made
          // Resend treat unrelated messages as the same entity.
          ...(referenceId ? { "X-Entity-Ref-ID": referenceId } : {}),
          "X-Mailer": "Trajetto Fleet Management System",
        },
      });

      return { messageId: info.messageId };
    } catch (error) {
      const deliveryError = toMailDeliveryError(
        error,
        `Falha ao enviar e-mail para ${to}`,
      );

      console.error(
        `[ResendMailProvider] ${deliveryError.message} (retryable=${deliveryError.retryable})`,
      );

      throw deliveryError;
    }
  }
}

export { ResendMailProvider };
