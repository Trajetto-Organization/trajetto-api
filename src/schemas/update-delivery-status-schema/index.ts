import { z } from "zod";
import {
  hasConsecutiveSpaces,
  hasSpaceAtEdges,
} from "@/shared/utils/zod-schema-helpers";

const updateDeliveryStatusSchema = z.object({
  status: z.enum(["PENDING", "IN_TRANSIT", "DELIVERED", "FAILED", "CANCELLED"], {
    errorMap: () => ({
      message:
        "Status inválido. Deve ser PENDING, IN_TRANSIT, DELIVERED, FAILED ou CANCELLED.",
    }),
  }),
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
      .optional()
      .describe("Quem recebeu a mercadoria — só faz sentido em DELIVERED."),
  ),
});

export { updateDeliveryStatusSchema };
