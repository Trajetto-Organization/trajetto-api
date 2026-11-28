import { z } from "zod";

import {
  hasConsecutiveSpaces,
  isEmptyOrWhitespace,
} from "@/shared/utils/zod-schema-helpers";
import { fieldError } from "@/shared/validation/field-error";

/**
 * The spaces around the name are trimmed, not refused (batch of
 * 14/11/2026): with the repository comparing the name whatever its case, "
 * cliente ausente" is the same reason as "Cliente ausente", and answers as
 * a name already taken (409) rather than as a typing error. The blank check
 * runs before the trim, so a name of spaces only still says so.
 */
const nameField = z
  .string(fieldError({ required: "O nome do motivo é obrigatório." }))
  .superRefine((value, ctx) => {
    if (isEmptyOrWhitespace(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "O nome do motivo não pode conter apenas espaços.",
      });
    }
  })
  .trim()
  .min(2, "O nome do motivo deve ter no mínimo 2 caracteres.")
  .max(80, "O nome do motivo deve ter no máximo 80 caracteres.")
  .superRefine((value, ctx) => {
    if (hasConsecutiveSpaces(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "O nome do motivo não deve conter espaços consecutivos.",
      });
    }
  });

/**
 * A word in the company's vocabulary for overriding a delivery's status.
 *
 * Short on purpose: this is what appears in a picker and in a timeline row,
 * and a sentence there is a sentence nobody can group or count. The detail
 * belongs in the note the operator types at the moment of the change.
 */
const createStatusChangeReasonSchema = z.object({
  name: nameField.describe('Ex.: "Cliente cancelou por telefone".'),
  description: z.preprocess(
    (value) => (value === "" ? null : value),
    z
      .string()
      .max(255, "A descrição deve ter no máximo 255 caracteres.")
      .nullable()
      .optional()
      .describe("Quando usar este motivo — aparece como ajuda no seletor."),
  ),
});

export { createStatusChangeReasonSchema, nameField };
