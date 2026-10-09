import { Prisma } from "@prisma/client";

import { dateOnlyKey } from "@/shared/time/business-day";

/**
 * Is this retry the same request that created the delivery?
 *
 * Decision 5.10: the same Idempotency-Key with the same body is the delivery
 * already created; the same key with a DIFFERENT body is a mistake on the
 * caller's side (a key reused for another document) and is refused with 409.
 * Answering it with the first delivery would tell the ERP that its second
 * document was accepted when nothing of it was written.
 *
 * There is no column holding a hash of the first body, so the comparison is
 * against the row itself, in the form the create wrote it: the text fields as
 * stored (empty is null), the date as its civil day, and the item amounts at
 * the scale of their `numeric` columns. The create WRITES the amounts already
 * at that scale (itemAtColumnScale), so what is compared is what was written,
 * never a guess at how the driver and the database round a float. Items are
 * compared as a multiset: their order is not a fact the delivery keeps.
 *
 * The honest limits, both documented: the row can be edited on the panel
 * after it was created, and a shipper named by CNPJ can have its CNPJ edited.
 * A retry of the ORIGINAL body then no longer matches, and answers 409 (with
 * the delivery's id) instead of pretending the edit did not happen.
 */
interface DraftItem {
  description: string;
  quantity?: number | null;
  unit?: string | null;
  unit_value?: number | null;
}

interface DeliveryDraft {
  shipperId: string | null;

  code?: string | null;
  invoice_key?: string | null;
  invoice_number?: string | null;

  recipient_name: string;
  recipient_document?: string | null;
  recipient_email?: string | null;
  recipient_telephone?: string | null;

  cep?: string | null;
  city: string;
  uf: string;
  street: string;
  address_number?: string | null;
  complement?: string | null;
  neighborhood?: string | null;

  scheduled_date?: Date | null;
  notes?: string | null;

  items?: DraftItem[] | null;
}

type DecimalLike = number | string | Prisma.Decimal;

interface StoredItem {
  description: string;
  quantity: DecimalLike;
  unit: string | null;
  unit_value: DecimalLike | null;
}

interface StoredDelivery extends Omit<DeliveryDraft, "shipperId" | "items" | "scheduled_date"> {
  shipperId: string;
  scheduled_date: Date | null;
  items: StoredItem[];

  /** The key that created it; null when the panel's form did. */
  apiKeyId: string | null;
}

/** DeliveryItem.quantity is numeric(10,3); DeliveryItem.unit_value numeric(10,2). */
const QUANTITY_SCALE = 3;
const UNIT_VALUE_SCALE = 2;

/**
 * Significant digits a float is read at before rounding to the column: the
 * precision Postgres casts a float8 to numeric with (DBL_DIG), and the most a
 * double carries without inventing digits.
 */
const FLOAT_SIGNIFICANT_DIGITS = 15;

const TEXT_FIELDS = [
  "code",
  "invoice_key",
  "invoice_number",
  "recipient_name",
  "recipient_document",
  "recipient_email",
  "recipient_telephone",
  "cep",
  "city",
  "uf",
  "street",
  "address_number",
  "complement",
  "neighborhood",
  "notes",
] as const;

/** What the create writes for an absent or empty text: null. */
function text(value: string | null | undefined): string | null {
  return value === undefined || value === null || value === "" ? null : value;
}

/**
 * An amount as its `numeric(p, scale)` column holds it, as a decimal string.
 *
 * A JSON number is a double: `3 * 1.115` computed by an ERP arrives as
 * 3.3449999999999998. Rounding those digits directly says 3.34; the database,
 * given the float, read it at 15 digits (3.345) and kept 3.35 — so an
 * identical retry was refused as "another body". Reading the float at 15
 * significant digits first gives the decimal the ERP meant and the value the
 * panel's create stores for the same number; rounding half up then matches
 * the column. A decimal read from the row is exact already.
 */
function atColumnScale(value: DecimalLike, scale: number): string {
  const decimal =
    typeof value === "number"
      ? new Prisma.Decimal(value.toPrecision(FLOAT_SIGNIFICANT_DIGITS))
      : new Prisma.Decimal(value);

  return decimal.toFixed(scale, Prisma.Decimal.ROUND_HALF_UP);
}

function scaled(value: DecimalLike | null | undefined, scale: number): string | null {
  if (value === undefined || value === null) return null;

  return atColumnScale(value, scale);
}

/**
 * The item as the create writes it: amounts already at their columns' scale,
 * so the column never rounds on its own and a replay compares against exactly
 * what was written. At most 10 significant digits (the schema's limits), which
 * a double carries exactly through any conversion on the way to Postgres.
 */
function itemAtColumnScale<T extends DraftItem>(item: T): T {
  return {
    ...item,
    ...(typeof item.quantity === "number" && {
      quantity: Number(atColumnScale(item.quantity, QUANTITY_SCALE)),
    }),
    ...(typeof item.unit_value === "number" && {
      unit_value: Number(atColumnScale(item.unit_value, UNIT_VALUE_SCALE)),
    }),
  };
}

function itemKey(item: {
  description: string;
  quantity: DecimalLike | null | undefined;
  unit: string | null | undefined;
  unit_value: DecimalLike | null | undefined;
}): string {
  return JSON.stringify([
    item.description,
    // The column's default when the create sent none.
    scaled(item.quantity ?? 1, QUANTITY_SCALE),
    text(item.unit),
    scaled(item.unit_value, UNIT_VALUE_SCALE),
  ]);
}

function fingerprint(
  fields: { [field in (typeof TEXT_FIELDS)[number]]?: string | null },
  shipperId: string | null,
  scheduledDate: Date | null | undefined,
  items: string[],
): string {
  return JSON.stringify({
    shipperId,
    ...Object.fromEntries(TEXT_FIELDS.map((field) => [field, text(fields[field])])),
    scheduled_date: scheduledDate ? dateOnlyKey(scheduledDate) : null,
    items: [...items].sort(),
  });
}

function draftFingerprint(draft: DeliveryDraft): string {
  return fingerprint(
    draft,
    draft.shipperId,
    draft.scheduled_date,
    (draft.items ?? []).map((item) =>
      itemKey({
        description: item.description,
        quantity: item.quantity,
        unit: item.unit,
        unit_value: item.unit_value,
      }),
    ),
  );
}

function storedFingerprint(stored: StoredDelivery): string {
  return fingerprint(
    stored,
    stored.shipperId,
    stored.scheduled_date,
    stored.items.map(itemKey),
  );
}

/** True when the retry carries the body that created `stored`. */
function isSameSubmission(draft: DeliveryDraft, stored: StoredDelivery): boolean {
  return draftFingerprint(draft) === storedFingerprint(stored);
}

export {
  atColumnScale,
  draftFingerprint,
  isSameSubmission,
  itemAtColumnScale,
  QUANTITY_SCALE,
  storedFingerprint,
  UNIT_VALUE_SCALE,
};
export type { DeliveryDraft, DraftItem, StoredDelivery, StoredItem };
