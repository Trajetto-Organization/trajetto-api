import { z } from "zod";

const hasSpaceAtEdges = (value: string) => /^\s|\s$/.test(value);
const hasConsecutiveSpaces = (value: string): boolean => /\s{2,}/.test(value);

const createKanbanColumnSchema = z.object({
  title: z
    .string()
    .min(1, "O título da coluna é obrigatório.")
    .max(50, "O título deve ter no máximo 50 caracteres.")
    .superRefine((value, ctx) => {
      if (hasConsecutiveSpaces(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "O título não deve conter espaços consecutivos.",
        });
        return;
      }

      if (hasSpaceAtEdges(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "O título não pode começar ou terminar com espaço em branco.",
        });
        return;
      }
    }),
  color: z
    .string()
    .min(1, "A cor é obrigatória.")
    .regex(
      /^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/,
      "Formato de cor inválido. Use formato hexadecimal (ex: #FF0000)",
    ),
});

export { createKanbanColumnSchema };
