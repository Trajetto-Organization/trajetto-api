import { z } from "zod";
import { fieldError } from "@/shared/validation/field-error";

/**
 * A reorder sends every column of the board. No board comes near this; the
 * cap only bounds what one request can make the API parse.
 */
const MAX_REORDERED_COLUMNS = 500;

const reorderKanbanColumnsSchema = z.object({
  businessId: z
    .string(fieldError({ required: "ID da empresa é obrigatório!" }))
    .uuid("ID da empresa é inválido."),
  columns: z
    .array(
      z.object({
        id: z
          .string(fieldError({ required: "ID da coluna é obrigatório!" }))
          .uuid("ID da coluna é inválido."),
        position: z
          .number()
          .int()
          .min(0, "Posição deve ser maior ou igual a 0."),
      }),
    )
    .min(1, "Deve haver pelo menos uma coluna para reordenar.")
    .max(
      MAX_REORDERED_COLUMNS,
      `Reordene no máximo ${MAX_REORDERED_COLUMNS} colunas por vez.`,
    ),
});

export { MAX_REORDERED_COLUMNS, reorderKanbanColumnsSchema };
