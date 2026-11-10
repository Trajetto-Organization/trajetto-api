import { MailProviderProps, MailSendResult } from "../dtos/mail-provider-dto";
import { IMailProvider } from "../IMail-provider";

import nodemailer, {
  SendMailOptions,
  SMTPPoolOptions,
  Transporter,
} from "nodemailer";

import { env } from "@/env";
import { logger } from "@/shared/logging/logger";
import { renderMailTemplate } from "../template-renderer";

import { toMailDeliveryError } from "../errors/mail-delivery-error";
import { buildMessageId, senderDomain } from "../message-id";
import { observeProviderCall } from "@/shared/health/provider-metrics";

const log = logger.child({ component: "mail-provider", provider: "resend" });

/**
 * Every timeout is bounded because sending now happens inside the
 * notification pipeline worker: an SMTP server that accepts the TCP
 * connection and then goes silent would otherwise hold a delivery slot (and
 * its lease) open indefinitely.
 *
 * Since nodemailer 10.1 connectionTimeout covers the DNS lookup, the TCP
 * connect, the greeting and the STARTTLS upgrade together (greetingTimeout
 * only caps the greeting inside it): ten seconds for the whole handshake.
 */
const SMTP_TIMEOUT_MS = 10_000;

/**
 * The transport, as options: built when the provider is, since it reads the
 * key from env, and pointed at a local server by the transport test.
 */
function resendTransportOptions(): SMTPPoolOptions & { pool: true } {
  return {
    host: "smtp.resend.com",
    port: 587, // STARTTLS

    // Upgrade or refuse. Without it nodemailer falls back to plain text
    // whenever the server does not offer STARTTLS — and anyone on the path
    // can strip that offer, then read the API key in AUTH and every
    // password reset and 2FA code in the body. nodemailer 10.0.0 to 10.0.11
    // ignored it (fixed in 10.0.12): the security floor test keeps them out.
    requireTLS: true,
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

    // Every message is HTML rendered in memory and carries no attachment.
    // Closed on the transport, so a content field that names a file path or
    // a URL can never make the API read its disk or fetch on its behalf.
    disableFileAccess: true,
    disableUrlAccess: true,
  };
}

/** The message handed to the transport for one send. */
function buildResendMessage({
  to,
  subject,
  html,
  referenceId,
}: {
  to: string;
  subject: string;
  html: string;
  referenceId?: string;
}): SendMailOptions {
  return {
    to,
    from: env.RESEND_FROM_EMAIL,
    subject,
    html,

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

      // The one idempotency a provider honours for us: Resend drops a
      // second message carrying the same key within 24 hours and answers
      // as if it had sent it. The pipeline passes the delivery id, so a
      // retry after a crash, a lost answer or an abandoned wait no longer
      // reaches the inbox twice. Neither X-Entity-Ref-ID nor the
      // Message-ID above does that — they only help a receiver thread.
      ...(referenceId ? { "Resend-Idempotency-Key": referenceId } : {}),
      "X-Mailer": "Trajetto Fleet Management System",
    },
  };
}

class ResendMailProvider implements IMailProvider {
  private client: Transporter;

  constructor() {
    this.client = nodemailer.createTransport(resendTransportOptions());
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
      // Timed per call for /health/metrics (latency and error rate per channel).
      const info = await observeProviderCall("EMAIL", () =>
        this.client.sendMail(
          buildResendMessage({
            to,
            subject,
            html: templateHTML,
            referenceId,
          }),
        ),
      );

      return { messageId: info.messageId };
    } catch (error) {
      // No recipient in the text (OBS-15): the delivery id in the pipeline's
      // log line already says which message this was.
      const deliveryError = toMailDeliveryError(
        error,
        "Falha ao enviar e-mail",
      );

      // The redacted error only: the raw transport error repeats the address
      // in its message and in fields the `err` serializer would copy.
      log.error(
        { err: deliveryError, retryable: deliveryError.retryable, referenceId },
        "e-mail send failed",
      );

      throw deliveryError;
    }
  }
}

export { ResendMailProvider, buildResendMessage, resendTransportOptions };
