import { z } from "zod";

const hasSpaceAtEdges = (value: string) => /^\s|\s$/.test(value);
const hasConsecutiveSpaces = (value: string): boolean => /\s{2,}/.test(value);

const isValidDateString = (value: string): boolean => {
  const date = new Date(value);
  return !isNaN(date.getTime());
};

// Helper function to convert empty strings to null
const emptyStringToNull = (value: any) => {
  if (typeof value === "string" && value.trim() === "") {
    return null;
  }

  return value;
};

// Helper function to convert string to boolean
const stringToBoolean = (value: any) => {
  if (typeof value === "string") {
    return value.toLowerCase() === "true";
  }
  return Boolean(value);
};

const updateKanbanCardSchema = z.object({
  title: z
    .string()
    .min(1, "O título do card é obrigatório.")
    .max(100, "O título deve ter no máximo 100 caracteres.")
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
    })
    .optional(),
  description: z
    .string()
    .min(1, "A descrição é obrigatória.")
    .max(500, "A descrição deve ter no máximo 500 caracteres.")
    .optional(),
  priority: z
    .enum(["low", "medium", "high", "urgent"], {
      errorMap: () => ({
        message: "Prioridade inválida. Use: baixa, média, alta ou urgente.",
      }),
    })
    .optional(),
  dueDate: z
    .string()
    .min(1, "A data de vencimento é obrigatória")
    .superRefine((val, ctx) => {
      if (!isValidDateString(val)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Data de vencimento inválida.",
        });
        return;
      }
    })
    .optional(),
  assignedUserId: z.preprocess(
    emptyStringToNull,
    z.string().uuid("ID do usuário inválido.").nullable().optional(),
  ),
  completed: z.preprocess(stringToBoolean, z.boolean().optional()),
});

export { updateKanbanCardSchema };
