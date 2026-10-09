import { Prisma } from "@prisma/client";

import database from "@/../infra/database";
import { logger } from "@/shared/logging/logger";

import {
  META_STATUS_RANK,
  type MetaStatusReport,
  type MetaTemplateUpdate,
} from "@/shared/providers/whatsapp-provider/meta-webhook";

/**
 * The provider receipts ledger (notification_provider_receipt): what a
 * provider said about a message after it accepted it.
 *
 * WhatsApp and Expo push have no idempotency key, so a send retried after a
 * crash can reach the recipient twice (ADR 0003: at-least-once). The ledger
 * does not prevent that — nothing on our side can — it makes it VISIBLE: one
 * row per (provider, message id, status), tied to the delivery that produced
 * the message. Two wamids under one delivery is a duplicate send; a 'failed'
 * after DELIVERED is a message the provider accepted and then lost.
 *
 * Writes are idempotent (createMany skipDuplicates over the unique key):
 * Meta repeats a callback it did not see a 200 for, and a receipts run can
 * overlap the next one.
 */
const log = logger.child({ component: "provider-receipts" });

/**
 * Which delivery each report belongs to. The callback data names it when the
 * send carried it; otherwise — a message sent before it did, or a callback
 * data that names nothing we hold — the wamid the pipeline recorded on the
 * delivery does (partial index on providerMessageId). A report no delivery
 * claims is still kept, untied: it is evidence of a send we cannot account
 * for.
 */
async function tieToDeliveries(
  reports: MetaStatusReport[],
): Promise<MetaStatusReport[]> {
  const named = [
    ...new Set(
      reports
        .map((report) => report.deliveryId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];

  const known = new Set(
    named.length > 0
      ? (
          await database.notificationDelivery.findMany({
            where: { id: { in: named } },
            select: { id: true },
          })
        ).map((row) => row.id)
      : [],
  );

  const untied = [
    ...new Set(
      reports
        .filter((report) => !report.deliveryId || !known.has(report.deliveryId))
        .map((report) => report.providerMessageId),
    ),
  ];

  const byWamid = new Map<string, string>();

  if (untied.length > 0) {
    const rows = await database.notificationDelivery.findMany({
      where: { providerMessageId: { in: untied } },
      select: { id: true, providerMessageId: true },
    });

    for (const row of rows) {
      if (row.providerMessageId) byWamid.set(row.providerMessageId, row.id);
    }
  }

  return reports.map((report) => ({
    ...report,
    deliveryId:
      report.deliveryId && known.has(report.deliveryId)
        ? report.deliveryId
        : (byWamid.get(report.providerMessageId) ?? null),
  }));
}

/**
 * Advances each delivery's `providerStatus` to the furthest status reported,
 * never backwards: a late 'sent' must not undo a 'read', and 'failed' is
 * final. The condition is in the UPDATE itself, so two callbacks racing on
 * two replicas cannot regress it either.
 */
async function advanceProviderStatus(
  latest: Map<string, { status: string; occurredAt: Date }>,
  rank: Record<string, number>,
): Promise<void> {
  for (const [deliveryId, { status, occurredAt }] of latest) {
    const lower = Object.keys(rank).filter((name) => rank[name] < rank[status]);

    await database.notificationDelivery.updateMany({
      where: {
        id: deliveryId,
        OR: [{ providerStatus: null }, { providerStatus: { in: lower } }],
      },
      data: { providerStatus: status, providerStatusAt: occurredAt },
    });
  }
}

/** The furthest-along report per delivery, by the provider's ranking. */
function furthestPerDelivery(
  reports: Array<{ deliveryId: string | null; status: string; occurredAt: Date }>,
  rank: Record<string, number>,
): Map<string, { status: string; occurredAt: Date }> {
  const latest = new Map<string, { status: string; occurredAt: Date }>();

  for (const report of reports) {
    if (!report.deliveryId || !(report.status in rank)) continue;

    const current = latest.get(report.deliveryId);

    if (!current || rank[report.status] > rank[current.status]) {
      latest.set(report.deliveryId, {
        status: report.status,
        occurredAt: report.occurredAt,
      });
    }
  }

  return latest;
}

/**
 * Records a batch of Meta status callbacks. Throws on a database failure, so
 * the route answers 5xx and Meta delivers the callback again.
 */
async function recordMetaStatuses(reports: MetaStatusReport[]): Promise<void> {
  if (reports.length === 0) return;

  const tied = await tieToDeliveries(reports);

  await database.notificationProviderReceipt.createMany({
    data: tied.map((report) => ({
      deliveryId: report.deliveryId,
      provider: "meta",
      providerMessageId: report.providerMessageId,
      status: report.status,
      errorCode: report.errorCode,
      errorMessage: report.errorMessage,
      occurredAt: report.occurredAt,
    })),
    skipDuplicates: true,
  });

  await advanceProviderStatus(
    furthestPerDelivery(tied, META_STATUS_RANK),
    META_STATUS_RANK,
  );

  for (const report of tied) {
    if (report.status !== "failed") continue;

    log.warn(
      {
        deliveryId: report.deliveryId,
        providerMessageId: report.providerMessageId,
        errorCode: report.errorCode,
        error: report.errorMessage,
      },
      "whatsapp message failed after Meta accepted it",
    );
  }

  await warnAboutRepeatedSends(tied);
}

/**
 * A delivery with more than one wamid went out more than once — the
 * duplicate the at-least-once guarantee allows. Logged with a stable message
 * so an alert can key on it; the ledger keeps the evidence.
 */
async function warnAboutRepeatedSends(
  reports: MetaStatusReport[],
): Promise<void> {
  const deliveryIds = [
    ...new Set(
      reports
        .map((report) => report.deliveryId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];

  if (deliveryIds.length === 0) return;

  const repeated = await database.$queryRaw<
    Array<{ deliveryId: string; wamids: number }>
  >`
    SELECT "deliveryId", COUNT(DISTINCT "providerMessageId")::int AS "wamids"
    FROM "notification_provider_receipt"
    WHERE "provider" = 'meta'
      AND "deliveryId" IN (${Prisma.join(deliveryIds)})
    GROUP BY "deliveryId"
    HAVING COUNT(DISTINCT "providerMessageId") > 1
  `;

  for (const row of repeated) {
    log.warn(
      { deliveryId: row.deliveryId, wamids: row.wamids },
      "whatsapp delivery reached Meta more than once",
    );
  }
}

/**
 * A template paused or disabled by Meta stops every WhatsApp that uses it, for
 * every tenant. Logged loudly with a stable message; the provider's lane
 * pause (see MetaCloudApiProvider), which the route now feeds from this same
 * callback (template-lane.ts), is what keeps the rows from failing.
 */
function logTemplateUpdates(updates: MetaTemplateUpdate[]): void {
  for (const update of updates) {
    const fields = {
      templateEvent: update.event,
      template: update.templateName,
      reason: update.reason,
    };

    if (update.event === "APPROVED") {
      log.info(fields, "whatsapp template status changed");
    } else {
      log.error(fields, "whatsapp template status changed");
    }
  }
}

/** Expo's word for a push, as the receipts job reads it. */
const EXPO_STATUS_RANK: Record<string, number> = {
  error: 1,
  ok: 2,
};

/**
 * One 'ticket' row per device Expo accepted the push for. The receipt — did
 * FCM/APNs take it, is the device still registered — only exists some
 * minutes later; check-push-receipts-job asks for it.
 */
async function recordExpoTickets(
  deliveryId: string,
  tickets: Array<{ id: string; token: string }>,
): Promise<void> {
  if (tickets.length === 0) return;

  await database.notificationProviderReceipt.createMany({
    data: tickets.map((ticket) => ({
      deliveryId,
      provider: "expo",
      providerMessageId: ticket.id,
      status: "ticket",
      pushToken: ticket.token,
      occurredAt: new Date(),
    })),
    skipDuplicates: true,
  });
}

export {
  EXPO_STATUS_RANK,
  advanceProviderStatus,
  furthestPerDelivery,
  logTemplateUpdates,
  recordExpoTickets,
  recordMetaStatuses,
};
