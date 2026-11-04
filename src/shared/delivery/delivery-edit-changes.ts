import { dateOnlyKey } from "@/shared/time/business-day";

import type {
  Delivery,
  DeliveryItemInput,
  UpdateDeliveryProps,
} from "@/modules/delivery/dtos/delivery-dto";

/**
 * What a panel edit changed in a delivery, in the words of its timeline
 * (K9).
 *
 * A delivery on a released route is on the driver's phone: when the office
 * fixes the address or the phone number, the route's plan moves a version
 * (the phone refetches and the driver is pushed) and the delivery's trail
 * says what changed. Only real changes count — the form resends every field
 * it shows, so a value sent as it was is not a change, and an edit that
 * changes nothing moves nothing.
 */

type Label = string;

const ADDRESS_KEYS = [
  "street",
  "address_number",
  "complement",
  "neighborhood",
  "city",
  "uf",
  "cep",
] as const;

/** One label per thing the driver or the office recognises, in this order. */
const SCALAR_LABELS: Array<[keyof UpdateDeliveryProps, Label]> = [
  ["recipient_name", "destinatário"],
  ["recipient_document", "documento do destinatário"],
  ["recipient_telephone", "telefone"],
  ["recipient_email", "e-mail"],
  ["scheduled_date", "data prevista"],
  ["notes", "observações"],
  ["kind", "tipo"],
  ["code", "código"],
  ["invoice_number", "nota fiscal"],
  ["invoice_key", "chave da nota fiscal"],
  ["shipperId", "embarcador"],
];

function text(value: unknown): string {
  if (value === null || value === undefined) return "";

  if (value instanceof Date) return dateOnlyKey(value);

  return String(value).trim();
}

function sameItems(
  current: DeliveryItemInput[],
  next: DeliveryItemInput[],
): boolean {
  // Order aside: the rows have no position column to read it back by.
  const shape = (items: DeliveryItemInput[]) =>
    JSON.stringify(
      items
        .map((item) =>
          JSON.stringify([
            item.description.trim(),
            Number(item.quantity ?? 1),
            item.unit || null,
            item.unit_value ?? null,
          ]),
        )
        .sort(),
    );

  return shape(current) === shape(next);
}

/**
 * The labels of what `patch` changes in `current`; [] when it changes
 * nothing. Text compares trimmed (the address case-insensitively, as
 * addressChanged does); a date compares by its civil day.
 */
function deliveryEditChanges(
  current: Delivery,
  currentItems: DeliveryItemInput[],
  patch: UpdateDeliveryProps,
): Label[] {
  const labels: Label[] = [];

  const differs = (key: keyof UpdateDeliveryProps) =>
    patch[key] !== undefined &&
    text(patch[key]) !== text(current[key as keyof Delivery]);

  if (
    ADDRESS_KEYS.some(
      (key) =>
        patch[key] !== undefined &&
        text(patch[key]).toLocaleLowerCase("pt-BR") !==
          text(current[key]).toLocaleLowerCase("pt-BR"),
    )
  ) {
    labels.push("endereço");
  }

  for (const [key, label] of SCALAR_LABELS) {
    if (differs(key)) labels.push(label);
  }

  if (patch.items !== undefined && !sameItems(currentItems, patch.items)) {
    labels.push("itens");
  }

  return labels;
}

/** "a, b e c". */
function joinPt(items: string[]): string {
  return items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} e ${items[items.length - 1]}`;
}

/** The timeline line of an edit to a delivery on a route (K9). */
function deliveryEditNote(labels: Label[]): string {
  return `Dados alterados no painel: ${joinPt(labels)}.`;
}

export { deliveryEditChanges, deliveryEditNote };
