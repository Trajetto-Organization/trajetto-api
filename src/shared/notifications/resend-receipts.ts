import { NotificationChannel } from "@prisma/client";

import database from "@/../infra/database";
import { logger } from "@/shared/logging/logger";

import {
  RESEND_STATUS_RANK,
  deliveryIdFromMessageId,
  type ResendEventReport,
} from "@/shared/providers/mail-provider/resend-webhook";

import {
  advanceProviderStatus,
  furthestPerDelivery,
} from "./provider-receipts";

const log = logger.child({ component: "provider-receipts" });

/** Where an e-mail stopped short of the inbox: worth a warning each time. */
const NOT_ARRIVED = new Set(["bounced", "complained", "failed", "suppressed"]);

/**
 * The delivery a Resend report is about (OBS-08).
 *
 * The pipeline sends every e-mail with Message-ID `<delivery id@domain>` and
 * records that same header as providerMessageId; Resend reports it back as
 * `message_id`. So, in order: the delivery the Message-ID names, when it is
 * an e-mail we hold; else a delivery whose recorded providerMessageId is the
 * Message-ID or Resend's own id (partial providerMessageId index). A report
 * no delivery claims is kept untied — a password reset or a 2FA code, which
 * never go through the pipeline, land here — and is purged with the other
 * untied receipts.
 */
async function tieToDelivery(
  report: ResendEventReport,
): Promise<string | null> {
  const named = deliveryIdFromMessageId(report.messageId);

  if (named) {
    const row = await database.notificationDelivery.findFirst({
      where: { id: named, channel: NotificationChannel.EMAIL },
      select: { id: true },
    });

    if (row) return row.id;
  }

  const recorded = [report.messageId, report.emailId].filter(
    (value): value is string => Boolean(value),
  );

  const row = await database.notificationDelivery.findFirst({
    where: {
      providerMessageId: { in: recorded },
      channel: NotificationChannel.EMAIL,
    },
    select: { id: true },
  });

  return row?.id ?? null;
}

/**
 * Records one Resend event in the receipts ledger and advances the
 * delivery's providerStatus, never backwards. Idempotent: Svix delivers again
 * whatever it did not see a 2xx for, and the ledger's (provider, message id,
 * status) key absorbs the repeat. Throws on a database failure, so the route
 * answers 5xx and Svix retries.
 */
async function recordResendEvent(report: ResendEventReport): Promise<void> {
  const deliveryId = await tieToDelivery(report);

  await database.notificationProviderReceipt.createMany({
    data: [
      {
        deliveryId,
        provider: "resend",
        providerMessageId: report.emailId,
        status: report.status,
        errorCode: report.errorCode,
        errorMessage: report.errorMessage,
        occurredAt: report.occurredAt,
      },
    ],
    skipDuplicates: true,
  });

  await advanceProviderStatus(
    furthestPerDelivery(
      [{ deliveryId, status: report.status, occurredAt: report.occurredAt }],
      RESEND_STATUS_RANK,
    ),
    RESEND_STATUS_RANK,
  );

  if (NOT_ARRIVED.has(report.status)) {
    // No address in the line (OBS-15): the delivery id and Resend's id find
    // the message; errorMessage is already masked.
    log.warn(
      {
        deliveryId,
        emailId: report.emailId,
        providerStatus: report.status,
        errorCode: report.errorCode,
        error: report.errorMessage,
      },
      "e-mail did not arrive after Resend accepted it",
    );
  }
}

export { recordResendEvent };
