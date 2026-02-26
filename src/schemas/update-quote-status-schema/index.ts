import { z } from "zod";
import {
  hasConsecutiveSpaces,
  hasSpaceAtEdges,
} from "@/shared/utils/zod-schema-helpers";

const updateQuoteStatusSchema = z.object({
  status: z.enum(["PENDING", "CONTACTED", "CLOSED", "CONVERTED"]),
  notes: z
    .string()
    .max(500, "As notas devem ter no máximo 500 caracteres")
    .superRefine((value, ctx) => {
      if (hasConsecutiveSpaces(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "O nome da nota não deve conter espaços consecutivos.",
        });

        return;
      }

      if (hasSpaceAtEdges(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "O nome da nota não pode começar ou terminar com espaço em branco.",
        });

        return;
      }
    })
    .optional(),
});

export { updateQuoteStatusSchema };
