import { Prisma, type WebhookDelivery } from "@prisma/client";

/**
 * The row a manual resend queues, built from the one being resent.
 *
 * A NEW row rather than resetting the old one: the record of what was sent
 * and what their server answered the first time is the first thing somebody
 * asks for when a duplicate is reported.
 *
 * Out of the controller so the dispatcher's test can queue exactly what the
 * resend button queues, and prove what a receiver sees the second time.
 */
function buildResendRow(
  original: Pick<
    WebhookDelivery,
    | "id"
    | "endpointId"
    | "businessId"
    | "topic"
    | "sourceEventId"
    | "payload"
    | "signed_body"
    | "signature"
  >,
): Prisma.WebhookDeliveryUncheckedCreateInput {
  return {
    endpointId: original.endpointId,
    businessId: original.businessId,
    topic: original.topic,

    // The event id travels with the resend — it is what the receiver
    // deduplicates on. A row queued before ids existed was sent with its own
    // row id in `X-Trajetto-Event-Id`, so that is the id its resend keeps.
    sourceEventId: original.sourceEventId ?? original.id,

    payload: original.payload as Prisma.InputJsonValue,

    // The same bytes and the same signature the first attempt carried.
    // Re-signing would produce a second event a receiver cannot match to
    // the first — which is exactly what somebody reporting a duplicate is
    // trying to work out.
    signed_body: original.signed_body,

    signature: original.signature,
    resent_from_id: original.id,
  };
}

export { buildResendRow };
