import type { DeliveryKind } from "@prisma/client";

/**
 * What a delivery record is (meeting of 14/10/2026): an "Entrega", an "Ordem
 * de serviço" — a stop to perform a service at the address, e.g. collecting
 * returnable baskets, unrelated to the fleet module's service order — or a
 * "Coleta". Same route, same driver, same proof: the kind changes the label,
 * the filter and the proof's title, never the flow.
 */
const DELIVERY_KINDS = [
  "DELIVERY",
  "PICKUP",
  "SERVICE_ORDER",
] as const satisfies readonly DeliveryKind[];

/**
 * What the panel form and the public API may write. PICKUP stays readable and
 * filterable, but only the spreadsheet's "coleta" creates it: the meeting
 * decided the form offers the two types it needs, and a third option nobody
 * asked for is a third thing to explain.
 */
const WRITABLE_DELIVERY_KINDS = [
  "DELIVERY",
  "SERVICE_ORDER",
] as const satisfies readonly DeliveryKind[];

type WritableDeliveryKind = (typeof WRITABLE_DELIVERY_KINDS)[number];

/** Portuguese, for the export's "Tipo" column: it is read by a person. */
const DELIVERY_KIND_LABELS: Record<DeliveryKind, string> = {
  DELIVERY: "Entrega",
  PICKUP: "Coleta",
  SERVICE_ORDER: "Ordem de serviço",
};

export {
  DELIVERY_KINDS,
  DELIVERY_KIND_LABELS,
  WRITABLE_DELIVERY_KINDS,
  type DeliveryKind,
  type WritableDeliveryKind,
};
