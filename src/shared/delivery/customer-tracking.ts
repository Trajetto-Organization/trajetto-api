import { DELIVERY_STATUS_LABELS, type DeliveryStatus } from "./delivery-rules";
import { resolveTimeZone } from "@/shared/time/business-day";

import type { TrackingSource } from "@/modules/delivery/repositories/IExternal-recipient-repository";
import type { PublicTrackingView } from "@/modules/delivery/dtos/external-recipient-dto";

/**
 * What the person waiting for a delivery is shown, and — more importantly —
 * what they are not.
 *
 * The link is the authorisation: no login, no session, and it gets forwarded
 * in family groups. So this function is written as a subtraction. The carrier's
 * operation stays out: no driver name, no driver phone, no plate, no route, no
 * other stop, no shipper, no internal note. What is left is the answer to the
 * only question the recipient actually has, which is "where is my thing and
 * when does it arrive".
 *
 * Pure, because what a stranger can see is a security decision, and a security
 * decision that needs a database to test is one nobody tests.
 */

/** The moments a customer can act on, in their words rather than ours. */
const EVENT_TITLES: Record<string, string> = {
  ARRIVAL: "O entregador chegou ao endereço",
  PROOF: "Entrega realizada",
};

function buildTrackingView(
  source: TrackingSource,
  props: { publicBaseUrl: string },
): PublicTrackingView {
  const { delivery } = source;

  const status = delivery.status as DeliveryStatus;

  const base = props.publicBaseUrl.replace(/\/+$/, "");

  const events: PublicTrackingView["events"] = [
    ...source.events.map((event) => ({
      at: event.created_at,
      title: EVENT_TITLES[event.type] ?? "Atualização",

      // The note is the operation writing to itself. It never crosses.
      detail: null as string | null,
    })),

    ...source.occurrences.map((occurrence) => ({
      at: occurrence.created_at,

      // The TYPE crosses — "destinatário ausente" is exactly what the customer
      // needs to hear. The free description does not: it is written by a
      // driver in the street, to the office, and it is regularly blunt.
      title: occurrence.typeName,
      detail: null as string | null,
    })),
  ].sort(
    (left, right) => new Date(right.at).getTime() - new Date(left.at).getTime(),
  );

  return {
    recipientName: delivery.recipient_name,

    city: delivery.city,
    uf: delivery.uf,

    status,
    statusLabel: DELIVERY_STATUS_LABELS[status] ?? delivery.status,

    invoiceNumber: delivery.invoice_number,
    code: delivery.code,

    scheduledDate: delivery.scheduled_date,
    deliveredAt: delivery.delivered_at,
    receivedBy: delivery.received_by,

    carrierName:
      delivery.business.fantasy_name?.trim() ||
      delivery.business.corporate_reason,

    timeZone: resolveTimeZone(delivery.business.timezone),

    events,

    // The public verification page, not the file. The customer gets the same
    // page anybody scanning the printed QR gets — one door, one story about
    // whether the document is genuine.
    proofUrl: source.proofToken
      ? `${base}/verificar/${source.proofToken}`
      : null,
  };
}

export { EVENT_TITLES, buildTrackingView };
