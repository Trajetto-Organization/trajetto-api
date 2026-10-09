import database from "@/../infra/database";

import { CronJobDefinition } from "@/shared/services/cron-scheduler-service";
import { logger } from "@/shared/logging/logger";

import {
  fetchExpoPushReceipts,
  type ExpoPushReceipt,
} from "@/shared/notifications/push-provider";
import {
  EXPO_STATUS_RANK,
  advanceProviderStatus,
  furthestPerDelivery,
} from "@/shared/notifications/provider-receipts";

const log = logger.child({ component: "cron", job: "check-push-receipts" });

const MINUTE_MS = 60 * 1000;

/** Expo publishes a receipt some minutes after the ticket; it advises ~15. */
const RECEIPT_DELAY_MS = 15 * MINUTE_MS;

/**
 * Expo keeps receipts for about a day. A ticket older than this that still
 * has none will never get one, and stops being asked for.
 */
const RECEIPT_WINDOW_MS = 23 * 60 * MINUTE_MS;

/** Expo's ceiling on ids per getReceipts call. */
const BATCH_SIZE = 1_000;

/** Well inside the scheduler's 10-minute execution lease. */
const RUN_BUDGET_MS = 2 * MINUTE_MS;

interface TicketRow {
  id: string;
  deliveryId: string | null;
  providerMessageId: string;
  pushToken: string | null;
  created_at: Date;
}

interface TicketVerdict {
  status: "ok" | "error" | "expired";
  errorCode: string | null;
  errorMessage: string | null;

  /** The device is gone for good: its token must stop being pushed to. */
  pruneToken: boolean;
}

/**
 * What one receipt means for its ticket, or null when Expo has none yet and
 * the ticket is still young enough to wait for one. Pure.
 */
function classifyExpoReceipt(
  receipt: ExpoPushReceipt | undefined,
  ticketCreatedAt: Date,
  now: Date,
): TicketVerdict | null {
  if (!receipt) {
    return now.getTime() - ticketCreatedAt.getTime() > RECEIPT_WINDOW_MS
      ? { status: "expired", errorCode: null, errorMessage: null, pruneToken: false }
      : null;
  }

  if (receipt.status === "ok") {
    return { status: "ok", errorCode: null, errorMessage: null, pruneToken: false };
  }

  const errorCode = receipt.details?.error ?? "error";

  return {
    status: "error",
    errorCode,
    errorMessage: receipt.message?.slice(0, 500) ?? null,
    // The only error that is about the DEVICE rather than this message or our
    // credentials. Most of them only ever show up here, in the receipt.
    pruneToken: errorCode === "DeviceNotRegistered",
  };
}

/**
 * Turns Expo push tickets into receipts (OUTBOX-07).
 *
 * A ticket only says Expo queued the push. The receipt says whether FCM or
 * APNs took it, and it is where most `DeviceNotRegistered` answers arrive —
 * before this job, those dead devices were never pruned and kept generating
 * push rows. Each checked ticket moves to ok | error | expired in the ledger,
 * the delivery's providerStatus follows (ok if any device took it), and a
 * device the receipt says is gone is deleted.
 *
 * Reads the ledger through its (provider, status, created_at) index: only
 * tickets old enough to have a receipt, oldest first.
 *
 * Cron: every 15 minutes.
 */
const checkPushReceiptsJob: CronJobDefinition = {
  name: "check-push-receipts",
  schedule: "*/15 * * * *",

  async handler() {
    const deadline = Date.now() + RUN_BUDGET_MS;

    let cursor = new Date(0);
    let checked = 0;
    let pruned = 0;

    while (Date.now() < deadline) {
      const now = new Date();

      const tickets: TicketRow[] =
        await database.notificationProviderReceipt.findMany({
          where: {
            provider: "expo",
            status: "ticket",
            created_at: {
              gt: cursor,
              lte: new Date(now.getTime() - RECEIPT_DELAY_MS),
            },
          },
          orderBy: { created_at: "asc" },
          take: BATCH_SIZE,
          select: {
            id: true,
            deliveryId: true,
            providerMessageId: true,
            pushToken: true,
            created_at: true,
          },
        });

      if (tickets.length === 0) break;

      cursor = tickets[tickets.length - 1].created_at;

      const receipts = await fetchExpoPushReceipts(
        tickets.map((ticket) => ticket.providerMessageId),
      );

      const settled: Array<{
        deliveryId: string | null;
        status: string;
        occurredAt: Date;
      }> = [];

      const deadTokens = new Set<string>();

      for (const ticket of tickets) {
        const verdict = classifyExpoReceipt(
          receipts[ticket.providerMessageId],
          ticket.created_at,
          now,
        );

        if (!verdict) continue;

        await database.notificationProviderReceipt.updateMany({
          where: { id: ticket.id, status: "ticket" },
          data: {
            status: verdict.status,
            errorCode: verdict.errorCode,
            errorMessage: verdict.errorMessage,
            checkedAt: now,
          },
        });

        checked += 1;

        if (verdict.status !== "expired") {
          settled.push({
            deliveryId: ticket.deliveryId,
            status: verdict.status,
            occurredAt: now,
          });
        }

        if (verdict.pruneToken && ticket.pushToken) {
          deadTokens.add(ticket.pushToken);
        }
      }

      await advanceProviderStatus(
        furthestPerDelivery(settled, EXPO_STATUS_RANK),
        EXPO_STATUS_RANK,
      );

      if (deadTokens.size > 0) {
        const { count } = await database.pushDeviceToken.deleteMany({
          where: { token: { in: [...deadTokens] } },
        });

        pruned += count;
      }

      if (tickets.length < BATCH_SIZE) break;
    }

    if (checked > 0 || pruned > 0) {
      log.info(
        { checkedTickets: checked, prunedDevices: pruned },
        "push receipts checked",
      );
    }
  },
};

export { checkPushReceiptsJob, classifyExpoReceipt };
