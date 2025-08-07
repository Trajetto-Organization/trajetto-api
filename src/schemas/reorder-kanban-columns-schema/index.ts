import { z } from "zod";

const reorderKanbanColumnsSchema = z.object({
  businessId: z.string().uuid("ID da empresa inválido."),
  columns: z
    .array(
      z.object({
        id: z.string().uuid("ID da coluna inválido."),
        position: z
          .number()
          .int()
          .min(0, "Posição deve ser maior ou igual a 0."),
      }),
    )
    .min(1, "Deve haver pelo menos uma coluna para reordenar."),
});

export { reorderKanbanColumnsSchema };
