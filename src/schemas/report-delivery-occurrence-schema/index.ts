import { z } from "zod";
import {
  hasConsecutiveSpaces,
  hasSpaceAtEdges,
} from "@/shared/utils/zod-schema-helpers";

const reportDeliveryOccurrenceSchema = z.object({
  occurrenceTypeId: z.string().min(1, "O tipo de ocorrência é obrigatório."),
  description: z.preprocess(
    (val) => (val === "" ? undefined : val),
    z
      .string()
      .max(500, "A descrição deve ter no máximo 500 caracteres.")
      .superRefine((value, ctx) => {
        if (hasConsecutiveSpaces(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "A descrição não deve conter espaços consecutivos.",
          });

          return;
        }

        if (hasSpaceAtEdges(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "A descrição não pode começar ou terminar com espaço em branco.",
          });
        }
      })
      .optional(),
  ),
  latitude: z.coerce.number().min(-90).max(90).optional(),
  longitude: z.coerce.number().min(-180).max(180).optional(),
  // Storage keys from the presigned flow — ownership and existence are
  // verified against the bucket before they become rows.
  photos: z
    .array(z.string().min(1).max(512))
    .max(5, "No máximo 5 fotos por ocorrência.")
    .optional(),
  client_submission_id: z
    .string()
    .uuid("A chave de idempotência do envio é inválida.")
    .optional(),
});

export { reportDeliveryOccurrenceSchema };
