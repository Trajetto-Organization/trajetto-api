import { z } from "zod";

import {
  DEFAULT_BUSINESS_TIMEZONE,
  businessDateKey,
  dateOnlyFromKey,
} from "@/shared/time/business-day";

import { birthDateIssue, birthDateKeyOf } from "@/modules/driver/driver-rules";

/**
 * A driver's birth date, shared by create and update and mirrored by the web
 * form (src/schemas/create-update-driver-schema).
 *
 * A civil day (decision 1.3): "YYYY-MM-DD" in — or the legacy form's local
 * midnight instant, read on its UTC day — and UTC midnight of that day
 * stored, so every screen reads it back in UTC as the same day. The age is
 * counted on civil days, never on the server's calendar.
 */
const birthDateField = z
  .string({ required_error: "A data de nascimento é obrigatória." })
  .min(1, "A data de nascimento é obrigatória.")
  .superRefine((value, ctx) => {
    // The company's zone is not known here; zones in Brazil differ by at
    // most two hours, which only matters on the evening of an 18th birthday.
    const today = businessDateKey(new Date(), DEFAULT_BUSINESS_TIMEZONE);
    const issue = birthDateIssue(value, today);

    if (issue) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: issue });
    }
  })
  .transform((value, ctx) => {
    const key = birthDateKeyOf(value);

    // Zod skips a transform once the refinement failed; this keeps a thrown
    // RangeError (a 500) impossible even if that ever changes.
    if (!key) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Data de nascimento inválida.",
      });

      return z.NEVER;
    }

    return dateOnlyFromKey(key);
  })
  .describe(
    "Data de nascimento, data civil AAAA-MM-DD (um instante ISO também é aceito e vale o dia UTC dele). O motorista precisa ter 18 anos completos.",
  );

export { birthDateField };
