import { z } from "zod";

import { emptyStringToNull } from "@/shared/utils/zod-schema-helpers";
import {
  DEFAULT_BUSINESS_TIMEZONE,
  businessDateKey,
  dateOnlyFromKey,
} from "@/shared/time/business-day";

import { cnhExpiryIssue } from "@/modules/driver/driver-rules";
import { CNH_CATEGORIES } from "@/modules/driver/usecases/list-driver/driver-list";

/**
 * The licence fields of a driver, shared by create and update and mirrored by
 * the web form (src/schemas/create-update-driver-schema).
 */

/** The CNH registration number: 11 digits; the mask's dots are dropped. */
const cnhNumberField = z.preprocess(
  (value) => (typeof value === "string" ? value.replace(/\D/g, "") : value),
  z
    .string({ required_error: "O número da CNH é obrigatório." })
    .min(1, "O número da CNH é obrigatório.")
    .regex(/^\d{11}$/, "A CNH deve ter exatamente 11 dígitos."),
);

const cnhCategoryField = z.preprocess(
  emptyStringToNull,
  z
    .enum(CNH_CATEGORIES, {
      errorMap: () => ({
        message: `A categoria da CNH deve ser uma destas: ${CNH_CATEGORIES.join(", ")}.`,
      }),
    })
    .nullable()
    .optional()
    .describe(
      "Categoria da CNH (CTB art. 143), combinadas incluídas (AB, AC, AD, AE). Vazio ou null: não informada.",
    ),
);

/**
 * A civil date (decision 1.3): "YYYY-MM-DD" in, UTC midnight of that day
 * stored in the `date` column. An instant would be stored as whatever UTC day
 * it falls on — 23:30 in Brasília is already tomorrow.
 */
const cnhExpiresAtField = z.preprocess(
  emptyStringToNull,
  z
    .string()
    .superRefine((value, ctx) => {
      // The company's zone is not known here; for a ten-year bound a day's
      // difference between zones is immaterial.
      const today = businessDateKey(new Date(), DEFAULT_BUSINESS_TIMEZONE);
      const issue = cnhExpiryIssue(value, today);

      if (issue) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: issue });
      }
    })
    .transform((value) => dateOnlyFromKey(value))
    .nullable()
    .optional()
    .describe(
      "Validade da CNH, data civil AAAA-MM-DD (sem hora). Vazio ou null: não informada.",
    ),
);

export { cnhCategoryField, cnhExpiresAtField, cnhNumberField };
