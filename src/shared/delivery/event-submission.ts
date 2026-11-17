import type { Prisma } from "@prisma/client";

/**
 * The trail's submission keys (plano-escala F2-14).
 *
 * The driver app resends a queued arrival, proof or "a caminho" after a
 * dead network, and the same `client_submission_id` must never become two
 * events. The global unique index on delivery_event.client_submission_id
 * said so until now; the trail moves to a table partitioned by month on its
 * id (F2-16, F2-17), which cannot hold that index, so the key also lands in
 * delivery_event_submission, primary key the key, in the SAME transaction as
 * the event. Its primary key is named after the column, so a P2002 of either
 * index names `client_submission_id` and the use cases' one replay-or-409
 * path (violatesUniqueOn) holds for both.
 *
 * The lookup reads this table first and falls back to the legacy column:
 * during the rolling deploy the previous image writes keys only on the
 * event, and the rows written before the backfill ran are there too. The
 * fallback goes once the copy window has run (U-10).
 */

type SubmissionClient = Pick<
  Prisma.TransactionClient,
  "deliveryEventSubmission"
>;

interface EventSubmission {
  clientSubmissionId: string;
  eventId: string;
  businessId: string;
}

/**
 * Records the key of an event just written. Must run on the transaction
 * that wrote the event: the two commit together or not at all, and a P2002
 * here rolls the event back with it.
 */
async function recordEventSubmission(
  tx: SubmissionClient,
  submission: EventSubmission,
): Promise<void> {
  await tx.deliveryEventSubmission.create({
    data: {
      client_submission_id: submission.clientSubmissionId,
      event_id: submission.eventId,
      businessId: submission.businessId,
    },
  });
}

/**
 * The id of the event a key wrote IN THIS COMPANY, or null. Another
 * company's key answers null, exactly like a key never used: the insert
 * then meets the primary key, and the caller answers 409 without telling a
 * driver token which keys exist at other carriers.
 */
async function submittedEventId(
  client: SubmissionClient,
  clientSubmissionId: string,
  businessId: string,
): Promise<string | null> {
  const found = await client.deliveryEventSubmission.findUnique({
    where: { client_submission_id: clientSubmissionId },
    select: { event_id: true, businessId: true },
  });

  return found && found.businessId === businessId ? found.event_id : null;
}

export { recordEventSubmission, submittedEventId };
export type { EventSubmission };
