import { z } from "zod";

import {
  hasConsecutiveSpaces,
  hasSpaceAtEdges,
  isEmptyOrWhitespace,
} from "@/shared/utils/zod-schema-helpers";

const nameField = z
  .string({ required_error: "O nome do motivo é obrigatório." })
  .min(2, "O nome do motivo deve ter no mínimo 2 caracteres.")
  .max(80, "O nome do motivo deve ter no máximo 80 caracteres.")
  .superRefine((value, ctx) => {
    if (isEmptyOrWhitespace(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "O nome do motivo não pode conter apenas espaços.",
      });

      return;
    }

    if (hasConsecutiveSpaces(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "O nome do motivo não deve conter espaços consecutivos.",
      });

      return;
    }

    if (hasSpaceAtEdges(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "O nome do motivo não pode começar ou terminar com espaço em branco.",
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
