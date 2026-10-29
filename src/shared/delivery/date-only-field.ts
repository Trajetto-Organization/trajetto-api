import { z } from "zod";

import { dateOnlyFromKey, dateOnlyKey } from "@/shared/time/business-day";

/**
 * A civil date on the wire: "YYYY-MM-DD", stored as UTC midnight (decision 1.3).
 *
 * The expected delivery date is a DAY the dispatcher picks, not an instant.
 * `z.coerce.date()` took any instant, so the web's local midnight (03:00Z in
 * Brasília) and the spreadsheet's UTC midnight both reached a `date` column,
 * and a late-evening instant in the company's zone would have been stored as
 * the next UTC day. Only the day itself is accepted now, and impossible days
 * (31/02) are refused instead of rolled over into March.
 *
 * Empty and null read as "no date", so an edit form can clear it.
 */
function dateOnlyField(label: string) {
  return z.preprocess(
    // A Date is this field's own output: the route validates the body and the
    // controller parses it again, so the second pass must accept it as is.
    (val) =>
      val === ""
        ? null
        : val instanceof Date && !Number.isNaN(val.getTime())
          ? dateOnlyKey(val)
          : val,
    z
      .string({
        invalid_type_error: `${label} deve estar no formato AAAA-MM-DD.`,
      })
      .transform((value, ctx) => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${label} deve estar no formato AAAA-MM-DD.`,
          });

          return z.NEVER;
        }

        try {
          return dateOnlyFromKey(value);
        } catch {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${label} não é uma data válida.`,
          });

          return z.NEVER;
        }
      })
      .nullable()
      .optional(),
  );
}

/** "DD/MM/AAAA" of a date-only value, read as the civil day it stores. */
function formatDateOnlyBR(value: Date | string | null | undefined): string {
  if (!value) return "";

  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) return "";

  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    // The column holds UTC midnight of the chosen day; any other zone west
    // of UTC would print the day before.
    timeZone: "UTC",
  }).format(date);
}

export { dateOnlyField, formatDateOnlyBR };
