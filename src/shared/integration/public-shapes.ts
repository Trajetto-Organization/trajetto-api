import { DELIVERY_STATUS_LABELS } from "@/shared/delivery/delivery-rules";

/**
 * What the public API answers with, and — more importantly — what it does not.
 *
 * Every field here is a promise. Adding one later does not break a subscriber;
 * removing or renaming one does, and that is what `v2` is for. So the shapes
 * are deliberately narrow: an internal id that leaks into a payload is an
 * internal id somebody's ERP will be storing next month.
 *
 * Every object carries THREE identifiers, which is the decision the reference
 * product taught: our id, the customer's own `code` from their ERP, and the
 * NF-e access key when there is one. An integration that can only match on one
 * of those is an integration that breaks the first time a customer's ERP
 * changes how it numbers things.
 */
interface PublicDelivery {
  id: string;
  code: string | null;
  invoice_key: string | null;

  invoice_number: string | null;

  status: string;
  status_label: string;

  /** DELIVERY, SERVICE_ORDER or PICKUP (meeting of 14/10/2026). */
  kind: string;

  recipient: {
    name: string;
    document: string | null;

    address: {
      street: string;
      number: string | null;
      complement: string | null;
      neighborhood: string | null;
      city: string;
      uf: string;
      zip_code: string | null;
    };
  };

  scheduled_date: string | null;
  delivered_at: string | null;
  received_by: string | null;

  /** The route it rides on, by OUR id and the number a person says out loud. */
  route: { id: string; code: number } | null;

  created_at: string;
  updated_at: string;
}

interface PublicRoute {
  id: string;
  code: number;
  name: string | null;

  status: string;

  scheduled_date: string;
  destination: string | null;
  planned_departure_at: string | null;
  planned_arrival_at: string | null;
  started_at: string | null;
  completed_at: string | null;

  driver: { id: string; name: string } | null;
  vehicle: { id: string; license_plate: string } | null;

  stops: Array<{
    sequence: number;
    status: string;

    delivery: { id: string; code: string | null; invoice_key: string | null };
  }>;

  created_at: string;
}

interface PublicEvent {
  id: string;
  topic: string;

  occurred_at: string;

  delivery: { id: string; code: string | null; invoice_key: string | null };

  data: Record<string, unknown>;
}

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;

  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

/**
 * The delivery, as an outside system sees it.
 *
 * Written as a projection and never as a spread of the row: a spread means
 * every column added to the table tomorrow is silently published to every
 * integration, including the ones that should not leave the building.
 */
function toPublicDelivery(delivery: {
  id: string;
  code: string | null;
  invoice_key: string | null;
  invoice_number: string | null;
  status: string;
  /** Absent on a row read without it: the column default. */
  kind?: string;
  recipient_name: string;
  recipient_document: string | null;
  street: string;
  address_number: string | null;
  complement: string | null;
  neighborhood: string | null;
  city: string;
  uf: string;
  cep: string | null;
  scheduled_date: Date | string | null;
  delivered_at: Date | string | null;
  received_by: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  stops?: Array<{ route: { id: string; code: number } | null }>;
}): PublicDelivery {
  const route = delivery.stops?.[0]?.route ?? null;

  return {
    id: delivery.id,
    code: delivery.code,
    invoice_key: delivery.invoice_key,
    invoice_number: delivery.invoice_number,

    status: delivery.status,
    status_label:
      DELIVERY_STATUS_LABELS[
        delivery.status as keyof typeof DELIVERY_STATUS_LABELS
      ] ?? delivery.status,

    kind: delivery.kind ?? "DELIVERY",

    recipient: {
      name: delivery.recipient_name,
      document: delivery.recipient_document,

      address: {
        street: delivery.street,
        number: delivery.address_number,
        complement: delivery.complement,
        neighborhood: delivery.neighborhood,
        city: delivery.city,
        uf: delivery.uf,
        zip_code: delivery.cep,
      },
    },

    scheduled_date: toIso(delivery.scheduled_date),
    delivered_at: toIso(delivery.delivered_at),
    received_by: delivery.received_by,

    route: route ? { id: route.id, code: route.code } : null,

    created_at: toIso(delivery.created_at)!,
    updated_at: toIso(delivery.updated_at)!,
  };
}

function toPublicRoute(route: {
  id: string;
  code: number;
  name: string | null;
  status: string;
  scheduled_date: Date | string;
  destination?: string | null;
  planned_departure_at?: Date | string | null;
  planned_arrival_at?: Date | string | null;
  started_at: Date | string | null;
  completed_at: Date | string | null;
  created_at: Date | string;
  driver?: { id: string; name: string } | null;
  vehicle?: { id: string; license_plate: string } | null;
  stops?: Array<{
    sequence: number;
    status: string;
    delivery: { id: string; code: string | null; invoice_key: string | null };
  }>;
}): PublicRoute {
  return {
    id: route.id,
    code: route.code,
    name: route.name,

    status: route.status,

    scheduled_date: toIso(route.scheduled_date)!,

    // Decision 6.5: where it goes and the planned window, so an ERP planning
    // its dock does not have to ask a person.
    destination: route.destination ?? null,
    planned_departure_at: toIso(route.planned_departure_at ?? null),
    planned_arrival_at: toIso(route.planned_arrival_at ?? null),

    started_at: toIso(route.started_at),
    completed_at: toIso(route.completed_at),

    driver: route.driver ?? null,
    vehicle: route.vehicle ?? null,

    stops: (route.stops ?? []).map((stop) => ({
      sequence: stop.sequence,
      status: stop.status,
      delivery: {
        id: stop.delivery.id,
        code: stop.delivery.code,
        invoice_key: stop.delivery.invoice_key,
      },
    })),

    created_at: toIso(route.created_at)!,
  };
}

export { toIso, toPublicDelivery, toPublicRoute };
export type { PublicDelivery, PublicEvent, PublicRoute };
