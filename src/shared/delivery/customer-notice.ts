import type { Prisma } from "@prisma/client";

import type { DeliveryCustomerPayload } from "@/shared/notifications/notification-types";

/**
 * The payload for the three messages a carrier sends the person waiting for
 * their delivery, built once and used from every place one of those moments
 * happens.
 *
 * Shared because the alternative is four use cases each assembling the same
 * twelve fields, and four places for one of them to be forgotten. The one that
 * matters most is the pair of contact details: a delivery with neither is a
 * delivery nobody is told about, and the policy decides that by reading this —
 * so a use case that left them out would silently turn the whole feature off
 * for its own path.
 */
interface CustomerNoticeSource {
  recipient_name: string;
  recipient_email?: string | null;
  recipient_telephone?: string | null;

  invoice_number?: string | null;
  code?: string | null;

  city: string;
  uf: string;

  scheduled_date?: Date | string | null;
  delivered_at?: Date | string | null;
  received_by?: string | null;

  businessId: string;
}

/**
 * The id is a separate argument rather than read off the row.
 *
 * The delivery DTO declares it optional — it is absent on a row not yet
 * written — and the caller always knows the id it addressed. Taking it
 * explicitly means this can never build a payload about "undefined".
 */
function buildDeliveryCustomerPayload(
  deliveryId: string,
  delivery: CustomerNoticeSource,
): DeliveryCustomerPayload {
  return {
    deliveryId,
    businessId: delivery.businessId,

    recipientName: delivery.recipient_name,
    recipientEmail: delivery.recipient_email ?? null,
    recipientTelephone: delivery.recipient_telephone ?? null,

    invoiceNumber: delivery.invoice_number ?? null,
    code: delivery.code ?? null,

    city: delivery.city,
    uf: delivery.uf,

    scheduledDate: delivery.scheduled_date ?? null,
    deliveredAt: delivery.delivered_at ?? null,
    receivedBy: delivery.received_by ?? null,
  };
}

/**
 * Whether there is anybody to tell.
 *
 * Takes only the two columns it reads, rather than a whole delivery: the route
 * module asks this about a stop's projection, which carries the contact details
 * and little else, and a parameter demanding fields the function never touches
 * would have forced a cast at the one call site that matters most.
 *
 * Checked before publishing rather than inside the policy so an outbox row is
 * never written for a delivery that can never produce a message. The row would
 * be claimed, expanded into nothing and marked published — work, a lock and a
 * log line, forever, for every delivery of every carrier that does not collect
 * customer contact details.
 */
function hasSomebodyToTell(delivery: {
  recipient_email?: string | null;
  recipient_telephone?: string | null;
}): boolean {
  return Boolean(delivery.recipient_email || delivery.recipient_telephone);
}

const CUSTOMER_TOPICS: ReadonlySet<string> = new Set([
  "delivery.dispatched",
  "delivery.on_the_way",
  "delivery.delivered",
  "delivery.failed",
]);

/**
 * How long "entregue" and "insucesso" wait for the stop's other NF-e
 * (decision D37): a driver proves three receipts at one door in a minute or
 * so, and the customer gets one message about the three. The cost is that
 * message arriving about 90 s later.
 */
const STOP_MERGE_WINDOW_MS = 90_000;

/**
 * How a customer moment is published once per STOP rather than per NF-e
 * (plan of 02/11/2026, B6; decision D37), or null to publish it as before.
 * Read by OutboxService.publish, in the publisher's transaction, so every
 * use case that announces a moment gets it without knowing.
 *
 * A delivery whose current stop shares its group (RouteStop.stop_group_key)
 * with another stop of its route publishes into the group's row:
 *
 *  - "saiu" and "a caminho" carry every delivery of the group (the render
 *    keeps the ones the moment is still true of), go out at once, and merge
 *    what the rest of the group publishes in the same transaction — the
 *    departure's loop, the mark that also marked the siblings. A group
 *    already told "a caminho" is not told again; a "saiu" for a NF-e added
 *    after the group's went out (K12) goes on its own;
 *  - "entregue" and "insucesso" open a 90 s window from the first sibling,
 *    and the siblings resolved inside it join the message; one resolved
 *    after it goes out on its own.
 *
 * Any other delivery costs one indexed lookup and publishes exactly as
 * before, its own event key included.
 */
async function customerStopGroup(
  tx: Prisma.TransactionClient,
  input: {
    topic: string;
    businessId?: string | null;
    payload: unknown;
  },
): Promise<{
  payload: DeliveryCustomerPayload;
  mergeKey: string;
  delayMs: number;
  whenTaken: "separate" | "skip";
} | null> {
  if (!CUSTOMER_TOPICS.has(input.topic) || !input.businessId) return null;

  const payload = input.payload as DeliveryCustomerPayload;

  // The delivery's current stop: its most recent one, of this company.
  const stop = await tx.routeStop.findFirst({
    where: {
      deliveryId: payload.deliveryId,
      route: { businessId: input.businessId },
    },
    orderBy: { created_at: "desc" },
    select: { id: true, routeId: true, stop_group_key: true },
  });

  if (!stop?.stop_group_key) return null;

  const resolved =
    input.topic === "delivery.delivered" || input.topic === "delivery.failed";

  // "Saiu" and "a caminho" speak of the whole visit: every open stop of the
  // group. "Entregue" and "insucesso" of this delivery; the siblings bring
  // theirs when they are resolved.
  const group = await tx.routeStop.findMany({
    where: {
      routeId: stop.routeId,
      stop_group_key: stop.stop_group_key,
      ...(resolved ? {} : { status: { in: ["PENDING", "ARRIVED"] } }),
    },
    orderBy: { sequence: "asc" },
    select: {
      deliveryId: true,
      delivery: { select: { invoice_number: true, code: true } },
    },
  });

  // A stop of its own after all: today's single message.
  if (group.length < 2) return null;

  const own = {
    deliveryId: payload.deliveryId,
    invoiceNumber: payload.invoiceNumber,
    code: payload.code,
  };

  const deliveries = resolved
    ? [own]
    : [
        own,
        ...group
          .filter((member) => member.deliveryId !== payload.deliveryId)
          .map((member) => ({
            deliveryId: member.deliveryId,
            invoiceNumber: member.delivery.invoice_number,
            code: member.delivery.code,
          })),
      ];

  return {
    payload: {
      ...payload,
      routeId: stop.routeId,
      stopGroupKey: stop.stop_group_key,
      deliveries,
    },
    mergeKey: `${input.topic}:${stop.routeId}:${stop.stop_group_key}`,
    delayMs: resolved ? STOP_MERGE_WINDOW_MS : 0,
    whenTaken: input.topic === "delivery.on_the_way" ? "skip" : "separate",
  };
}

export {
  CUSTOMER_TOPICS,
  STOP_MERGE_WINDOW_MS,
  buildDeliveryCustomerPayload,
  customerStopGroup,
  hasSomebodyToTell,
};
export type { CustomerNoticeSource };
