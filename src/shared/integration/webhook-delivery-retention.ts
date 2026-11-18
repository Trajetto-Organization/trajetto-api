import { Prisma } from "@prisma/client";

import type { BatchDeleteClient } from "@/shared/database/batch-delete";
import type {
  PartitionDropGate,
  PartitionToDrop,
} from "@/shared/database/partition-drop-gate";
import { logger } from "@/shared/logging/logger";
import { uuid7Floor } from "@/shared/time/uuid7-floor";

const log = logger.child({ component: "webhook-delivery-retention" });

/**
 * The gate the partition-maintenance job asks before it detaches a day of
 * webhook_delivery past WEBHOOK_DELIVERY_RETENTION_DAYS (plano-escala
 * F5-12): never with a row the dispatcher still owns. A PENDING or
 * PROCESSING row belongs to it whatever its age (a parked one waits for
 * its endpoint until the replay window closes it as FAILED), exactly as
 * the purge in batches never matches one. The predicate is the claim
 * index's (webhook_delivery_claim_idx), so the probe of a day reads a
 * handful of entries. A settled day has nothing to copy: the ledger keeps
 * no dead letter of its own.
 *
 * The retention is at least the replay window plus a day, so a row a
 * resend may still pick (30 days from its created_at, its id's day) is in
 * a partition that ends after the cutoff.
 */
function createWebhookDeliveryGate(options: {
  db: BatchDeleteClient;
}): PartitionDropGate {
  const { db } = options;

  return {
    async mayDrop(parent: string, partition: PartitionToDrop) {
      const from = partition.from ? uuid7Floor(partition.from) : null;
      const to = uuid7Floor(partition.to);
      const range =
        from === null
          ? Prisma.sql`"id" < ${to}`
          : Prisma.sql`"id" >= ${from} AND "id" < ${to}`;

      try {
        const [row] = await db.$queryRaw<Array<{ busy: boolean }>>`
          SELECT EXISTS (
            SELECT 1 FROM "webhook_delivery"
            WHERE ${range} AND "status" IN ('PENDING', 'PROCESSING')
          ) AS busy
        `;

        if (row?.busy) {
          log.info(
            { table: parent, partition: partition.name },
            "webhook delivery day still owned by the dispatcher: kept",
          );

          return false;
        }

        return true;
      } catch (error) {
        log.warn(
          {
            table: parent,
            partition: partition.name,
            error: error instanceof Error ? error.message : String(error),
          },
          "webhook delivery day could not be checked: kept",
        );

        return false;
      }
    },
  };
}

export { createWebhookDeliveryGate };
