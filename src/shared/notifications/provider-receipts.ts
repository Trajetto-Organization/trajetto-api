import { Prisma } from "@prisma/client";

import database from "@/../infra/database";
import { logger } from "@/shared/logging/logger";

import {
  META_STATUS_RANK,
  templateCategoryAlarms,
  type MetaCategoryUpdate,
  type MetaStatusReport,
  type MetaTemplateUpdate,
} from "@/shared/providers/whatsapp-provider/meta-webhook";

import { receiptFactKey, receiptIdFor } from "./receipt-id";

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
 * Writes are idempotent: Meta repeats a callback it did not see a 200 for,
 * two replicas can take the same one, and a receipts run can overlap the
 * next one. One row per (provider, message id, status), with or without
 * the unique that wave 10 drops (F5-06): insertReceipts below.
 */
const log = logger.child({ component: "provider-receipts" });

type ReceiptRow = Prisma.NotificationProviderReceiptCreateManyInput & {
  id: string;
};

/**
 * Writes receipts, one row per fact (provider, message id, status),
 * whatever id each copy of the fact computes (plano-escala F5-04).
 *
 * The id is decided by the fact in the usual case (receipt-id.ts), and a
 * repeat is then a primary-key conflict. But its anchor also follows the
 * tie and the day: the delivery's millisecond when the report is tied,
 * else midnight of occurredAt held inside the untied retention. A status
 * Meta sent before the worker recorded the wamid and its repeat after the
 * commit, or an untied report held at today and repeated tomorrow, are two
 * ids for one fact. The unique (provider, providerMessageId, status)
 * absorbs them today; wave 10 (F5-06) drops it, and keeps a plain index on
 * the same columns for this read. So the write takes a transaction lock
 * per fact (in key order, so two writers never deadlock), reads which of
 * its facts the ledger already holds under any id, and inserts only the
 * others: two replicas taking copies of one fact at once serialize on the
 * lock, and the second finds the first's row. That row stays as written:
 * its id is its partition, and its tie is what was known when it arrived.
 */
async function insertReceipts(rows: ReceiptRow[]): Promise<void> {
  if (rows.length === 0) return;

  const facts = new Map<string, ReceiptRow>();

  for (const row of rows) {
    const key = receiptFactKey(row);

    if (!facts.has(key)) facts.set(key, row);
  }

  await database.$transaction(async (tx) => {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(lock_key)
      FROM (
        SELECT DISTINCT hashtextextended('provider-receipt:' || fact, 0) AS lock_key
        FROM unnest(${[...facts.keys()]}::text[]) AS fact
        ORDER BY lock_key
      ) AS locks
    `;

    const held = await tx.notificationProviderReceipt.findMany({
      where: {
        OR: [...facts.values()].map((row) => ({
          provider: row.provider,
          providerMessageId: row.providerMessageId,
          status: row.status,
        })),
      },
      select: { provider: true, providerMessageId: true, status: true },
    });

    for (const row of held) facts.delete(receiptFactKey(row));

    if (facts.size === 0) return;

    await tx.notificationProviderReceipt.createMany({
      data: [...facts.values()],
      skipDuplicates: true,
    });
  });
}

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
  reports: Array<{
    deliveryId: string | null;
    status: string;
    occurredAt: Date;
  }>,
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
  const now = new Date();

  await insertReceipts(
    tied.map((report) => ({
      id: receiptIdFor({ ...report, provider: "meta" }, now),
      deliveryId: report.deliveryId,
      provider: "meta",
      providerMessageId: report.providerMessageId,
      status: report.status,
      errorCode: report.errorCode,
      errorMessage: report.errorMessage,
      occurredAt: report.occurredAt,
    })),
  );

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
/**
 * Meta moved templates to another category (plan of 02/11/2026, B7). One of
 * ours leaving UTILITY is an ERROR line — the alert: it is billed and
 * treated as Marketing from then on, for every tenant. The rest is info.
 */
function logTemplateCategoryUpdates(updates: MetaCategoryUpdate[]): void {
  const alarms = new Set(templateCategoryAlarms(updates));

  for (const update of updates) {
    const fields = {
      template: update.templateName,
      language: update.language,
      previousCategory: update.previousCategory,
      newCategory: update.newCategory,
      announced: update.announced,
    };

    if (alarms.has(update)) {
      log.error(
        fields,
        update.announced
          ? "whatsapp template will be recategorized by Meta: review its text before it leaves UTILITY"
          : "whatsapp template recategorized by Meta out of UTILITY",
      );
    } else {
      log.info(fields, "whatsapp template category changed");
    }
  }
}

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

  const now = new Date();

  await database.notificationProviderReceipt.createMany({
    data: tickets.map((ticket) => ({
      id: receiptIdFor(
        {
          deliveryId,
          provider: "expo",
          providerMessageId: ticket.id,
          status: "ticket",
          occurredAt: now,
        },
        now,
      ),
      deliveryId,
      provider: "expo",
      providerMessageId: ticket.id,
      status: "ticket",
      pushToken: ticket.token,
      occurredAt: now,
    })),
    skipDuplicates: true,
  });
}

export {
  EXPO_STATUS_RANK,
  advanceProviderStatus,
  furthestPerDelivery,
  insertReceipts,
  logTemplateCategoryUpdates,
  logTemplateUpdates,
  recordExpoTickets,
  recordMetaStatuses,
};
