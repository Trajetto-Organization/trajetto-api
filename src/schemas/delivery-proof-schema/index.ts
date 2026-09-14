import { z } from "zod";
import {
  hasConsecutiveSpaces,
  hasSpaceAtEdges,
} from "@/shared/utils/zod-schema-helpers";

/**
 * Proof of delivery from the driver app. The photo and signature are
 * storage keys from the presigned flow — the bytes never touch the API;
 * ownership and existence are verified against the bucket before the keys
 * become rows.
 */
const deliveryProofSchema = z.object({
  client_submission_id: z
    .string({
      required_error: "A chave de idempotência do envio é obrigatória.",
    })
    .uuid("A chave de idempotência do envio é inválida."),
  photo: z
    .string({ required_error: "A foto do canhoto é obrigatória." })
    .min(1, "A foto do canhoto é obrigatória.")
    .max(512),
  signature: z.string().min(1).max(512).optional(),
  received_by: z.preprocess(
    (val) => (val === "" ? undefined : val),
    z
      .string()
      .max(150, "O nome de quem recebeu deve ter no máximo 150 caracteres.")
      .superRefine((value, ctx) => {
        if (hasConsecutiveSpaces(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "O nome de quem recebeu não deve conter espaços consecutivos.",
          });

          return;
        }

        if (hasSpaceAtEdges(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "O nome de quem recebeu não pode começar ou terminar com espaço em branco.",
          });
        }
      })
      .optional(),
  ),
  latitude: z.coerce.number().min(-90).max(90).optional(),
  longitude: z.coerce.number().min(-180).max(180).optional(),
});

export { deliveryProofSchema };
