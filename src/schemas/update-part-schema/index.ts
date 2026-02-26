import { z } from "zod";
import {
  hasConsecutiveSpaces,
  hasSpaceAtEdges,
} from "@/shared/utils/zod-schema-helpers";

const updatePartSchema = z.object({
  description: z
    .string()
    .min(3, "A descrição deve ter no mínimo 3 caracteres.")
    .max(100, "A descrição deve ter no máximo 100 caracteres.")
    .superRefine((value, ctx) => {
      if (value.length > 100) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "O nome não deve exceder 100 caracteres.",
        });

        return;
      }

      if (hasConsecutiveSpaces(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "O nome não deve conter espaços consecutivos.",
        });

        return;
      }

      if (hasSpaceAtEdges(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "O nome não pode começar ou terminar com espaço em branco.",
        });

        return;
      }

      const regex = /^(?=[\p{L}\p{N}])[ \p{L}\p{N}\p{P}]*(?<=[\p{L}\p{N}])$/u;
      if (!regex.test(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "O nome deve começar e terminar com letra ou número; símbolos (ex.: @, _, -, .) só são permitidos no meio.",
        });
      }
    })
    .optional(),
  unit_price: z
    .number()
    .positive("O preço unitário deve ser um valor positivo.")
    .max(999999.99, "O preço unitário não pode exceder 999.999,99.")
    .optional(),
  supplierId: z
    .string()
    .uuid("O ID do fornecedor deve ser um UUID válido.")
    .optional()
    .nullable(),
  businessId: z
    .string()
    .uuid("O ID da empresa deve ser um UUID válido.")
    .optional(),
});

export { updatePartSchema };
