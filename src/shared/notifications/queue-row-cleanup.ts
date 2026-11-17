import { Prisma } from "@prisma/client";

/**
 * What a deletion takes from the queues, said in SQL instead of left to the
 * foreign keys (plano-escala F5-05).
 *
 * Today notification_delivery, notification_provider_receipt and
 * webhook_delivery hang off user, external_recipient, webhook_endpoint and
 * business through ON DELETE CASCADE. Wave 10 (F5-06) drops those keys:
 * the queues become partitioned by day, and a foreign key into a hot table
 * would lock user and business every time a day's partition is dropped.
 * So each deletion takes its own rows, in its own transaction, before the
 * row they hang off — the same rows the cascade takes, no more:
 *
 *  - a user: the deliveries addressed to them, and their receipts;
 *  - a webhook endpoint: its webhook deliveries;
 *  - a company: its webhook deliveries, and the deliveries addressed to its
 *    users and to its external recipients (both go by cascade from the
 *    company), with their receipts. The use case refuses a company that
 *    still has users; the repository does not rely on it. The deliveries
 *    of the platform's own users about the company are not its rows.
 *
 * A row written by a transaction that committed after the deletion read
 * the queue escapes it. The pipeline closes such a row as recipient_gone,
 * without calling a provider (delivery-diagnostics.ts, decision D54), and
 * the day's purge takes it. tests/unitaires/database/queue-deletion-paths
 * lists every path that deletes one of these parents and proves each one
 * comes through here; tests/E2E/queue-no-cascade.test.ts drops the keys
 * and proves nothing is left.
 *
 * Every statement filters by the parent's id, through the queues' own
 * indexes (userId, externalRecipientId, endpointId, businessId, the
 * receipts' deliveryId): the ids as one array (`= ANY (ARRAY(...))`), never
 * a join the planner could answer by hashing a whole queue.
 */

type Queries = Pick<Prisma.TransactionClient, "$executeRaw">;

/** The statuses a delivery is still waiting or being sent in. */
const UNSENT = Prisma.sql`('PENDING', 'PROCESSING')`;

/**
 * The deliveries addressed to a user and their receipts. `unsentOnly`
 * keeps the ledger (DELIVERED and FAILED rows) when the user stays and
 * only what was still to be sent must go.
 */
async function deleteQueueRowsOfUser(
  db: Queries,
  userId: string,
  { unsentOnly = false }: { unsentOnly?: boolean } = {},
): Promise<void> {
  await db.$executeRaw`
    WITH deliveries AS (
      DELETE FROM "notification_delivery"
      WHERE "userId" = ${userId}
        ${unsentOnly ? Prisma.sql`AND "status" IN ${UNSENT}` : Prisma.empty}
      RETURNING "id"
    )
    DELETE FROM "notification_provider_receipt"
    WHERE "deliveryId" = ANY (ARRAY(SELECT "id" FROM deliveries))
  `;
}

/** The webhook deliveries of one endpoint of the company. */
async function deleteQueueRowsOfWebhookEndpoint(
  db: Queries,
  endpointId: string,
  businessId: string,
): Promise<void> {
  await db.$executeRaw`
    DELETE FROM "webhook_delivery"
    WHERE "endpointId" = ${endpointId} AND "businessId" = ${businessId}
  `;
}

/**
 * The company's webhook deliveries, and the deliveries addressed to its
 * users and external recipients, with their receipts.
 */
async function deleteQueueRowsOfBusiness(
  db: Queries,
  businessId: string,
): Promise<void> {
  await db.$executeRaw`
    WITH webhooks AS (
      DELETE FROM "webhook_delivery"
      WHERE "businessId" = ${businessId}
    ),
    to_users AS (
      DELETE FROM "notification_delivery"
      WHERE "userId" = ANY (ARRAY(
        SELECT "id" FROM "user" WHERE "businessId" = ${businessId}
      ))
      RETURNING "id"
    ),
    to_externals AS (
      DELETE FROM "notification_delivery"
      WHERE "externalRecipientId" = ANY (ARRAY(
        SELECT "id" FROM "external_recipient" WHERE "businessId" = ${businessId}
      ))
      RETURNING "id"
    )
    DELETE FROM "notification_provider_receipt"
    WHERE "deliveryId" = ANY (ARRAY(
      SELECT "id" FROM to_users UNION ALL SELECT "id" FROM to_externals
    ))
  `;
}

export {
  deleteQueueRowsOfBusiness,
  deleteQueueRowsOfUser,
  deleteQueueRowsOfWebhookEndpoint,
};
