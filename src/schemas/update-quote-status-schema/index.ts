import { z } from "zod";

const hasSpaceAtEdges = (value: string) => /^\s|\s$/.test(value);
const hasConsecutiveSpaces = (value: string): boolean => /\s{2,}/.test(value);

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
