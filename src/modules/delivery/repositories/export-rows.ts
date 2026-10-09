import type { Prisma } from "@prisma/client";

import {
  DELIVERY_STATUS_LABELS,
  type DeliveryStatus,
} from "@/shared/delivery/delivery-rules";

/**
 * The rows the deliveries and occurrences exports write, one function each,
 * shared by the Prisma repository and its in-memory twin (decision 13.2).
 *
 * The twin used to yield the raw entity: English status, no shipper or
 * driver names, no typeName/blocking/photoCount. A unit test of the export
 * use case then proved columns the spreadsheet never had. The projection is
 * now one piece of code; each repository only says where the related names
 * come from.
 */

interface DeliveryExportColumns {
  id?: string;
  code?: string | null;
  invoice_key?: string | null;
  invoice_number?: string | null;
  status: DeliveryStatus;
  recipient_name: string;
  recipient_document?: string | null;
  recipient_telephone?: string | null;
  street: string;
  address_number?: string | null;
  neighborhood?: string | null;
  city: string;
  uf: string;
  cep?: string | null;
  scheduled_date?: Date | string | null;
  delivered_at?: Date | string | null;
  received_by?: string | null;
  notes?: string | null;
}

interface DeliveryExportRelations {
  shipperName: string | null;
  driverName: string | null;
  vehiclePlate: string | null;
  /** The code of the route holding the delivery's latest stop. */
  routeCode: number | null;
}

function deliveryExportRow(
  delivery: DeliveryExportColumns,
  related: DeliveryExportRelations,
): Record<string, unknown> {
  return {
    id: delivery.id,
    code: delivery.code ?? null,
    invoice_key: delivery.invoice_key ?? null,
    invoice_number: delivery.invoice_number ?? null,

    // Portuguese, because an export is read by a person in Excel and
    // "IN_TRANSIT" in a column called Status has to be explained every
    // single time.
    status: DELIVERY_STATUS_LABELS[delivery.status],

    recipient_name: delivery.recipient_name,
    recipient_document: delivery.recipient_document ?? null,
    recipient_telephone: delivery.recipient_telephone ?? null,

    street: delivery.street,
    address_number: delivery.address_number ?? null,
    neighborhood: delivery.neighborhood ?? null,
    city: delivery.city,
    uf: delivery.uf,
    cep: delivery.cep ?? null,

    shipperName: related.shipperName,
    driverName: related.driverName,
    vehiclePlate: related.vehiclePlate,
    routeCode: related.routeCode,

    scheduled_date: delivery.scheduled_date ?? null,
    delivered_at: delivery.delivered_at ?? null,
    received_by: delivery.received_by ?? null,
    notes: delivery.notes ?? null,
  };
}

interface OccurrenceExportColumns {
  id: string;
  created_at: Date;
  occurred_at?: Date | null;
  category?: string | null;
  description?: string | null;
  photos?: string[] | null;
  form_answers?: Prisma.JsonValue | Record<string, unknown> | null;
  authorization_status?: string | null;
  authorized_at?: Date | null;
  authorization_note?: string | null;
}

interface OccurrenceExportRelations {
  typeName: string | null;
  blocksDelivery: boolean;
  formFields: unknown;
  delivery: {
    id: string;
    recipient_name: string;
    city: string;
    uf: string;
  } | null;
  reporterName: string | null;
  deciderName: string | null;
}

function occurrenceExportRow(
  occurrence: OccurrenceExportColumns,
  related: OccurrenceExportRelations,
): Record<string, unknown> {
  return {
    id: occurrence.id,
    // When it was reported in the street, for a report the app sent later;
    // the export's keyset stays on created_at.
    created_at: occurrence.occurred_at ?? occurrence.created_at,
    typeName: related.typeName,
    // Decision 14.3: a proof is "Entrega", a problem "Não entrega".
    category: occurrence.category === "DELIVERED" ? "Entrega" : "Não entrega",

    // "Sim"/"Não" rather than true/false: the column is read, filtered and
    // counted by a person in a spreadsheet.
    blocking: related.blocksDelivery ? "Sim" : "Não",

    deliveryId: related.delivery?.id ?? null,
    recipientName: related.delivery?.recipient_name ?? null,
    city: related.delivery?.city ?? null,
    uf: related.delivery?.uf ?? null,

    reporterName: related.reporterName,
    description: occurrence.description ?? null,
    photoCount: occurrence.photos?.length ?? 0,

    // Decisions 6.2 and 6.3: the answers against the type's current form
    // (labelled by the export), and the tower's decision.
    formAnswers: {
      fields: related.formFields ?? null,
      answers: occurrence.form_answers ?? null,
    },
    // The column's default when the row never asked the tower.
    authorizationStatus: occurrence.authorization_status ?? "NOT_REQUIRED",
    deciderName: related.deciderName,
    decidedAt: occurrence.authorized_at ?? null,
    decisionNote: occurrence.authorization_note ?? null,
  };
}

/** The exports' order: creation, the id breaking a tie (the keyset). */
function byCreationThenId(
  a: { created_at?: Date | string; id?: string },
  b: { created_at?: Date | string; id?: string },
): number {
  const at = (row: { created_at?: Date | string }) =>
    new Date(row.created_at ?? 0).getTime();
  const idOf = (row: { id?: string }) => row.id ?? "";

  return at(a) - at(b) || (idOf(a) < idOf(b) ? -1 : idOf(a) > idOf(b) ? 1 : 0);
}

export { byCreationThenId, deliveryExportRow, occurrenceExportRow };
export type {
  DeliveryExportColumns,
  DeliveryExportRelations,
  OccurrenceExportColumns,
  OccurrenceExportRelations,
};
