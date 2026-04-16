import { z } from "zod";

const reorderKanbanColumnsSchema = z.object({
  businessId: z
    .string({ required_error: "ID da empresa é obrigatório!" })
    .uuid("ID da empresa é inválido."),
  columns: z
    .array(
      z.object({
        id: z
          .string({ required_error: "ID da coluna é obrigatório!" })
          .uuid("ID da coluna é inválido."),
        position: z
          .number()
          .int()
          .min(0, "Posição deve ser maior ou igual a 0."),
      }),
    )
    .min(1, "Deve haver pelo menos uma coluna para reordenar."),
});

export { reorderKanbanColumnsSchema };
