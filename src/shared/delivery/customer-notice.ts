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
 * Checked before publishing rather than inside the policy so an outbox row is
 * never written for a delivery that can never produce a message. The row would
 * be claimed, expanded into nothing and marked published — work, a lock and a
 * log line, forever, for every delivery of every carrier that does not collect
 * customer contact details.
 */
function hasSomebodyToTell(delivery: CustomerNoticeSource): boolean {
  return Boolean(delivery.recipient_email || delivery.recipient_telephone);
}

export { buildDeliveryCustomerPayload, hasSomebodyToTell };
export type { CustomerNoticeSource };
