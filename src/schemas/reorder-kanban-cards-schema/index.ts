import { z } from "zod";

const reorderKanbanCardsSchema = z.object({
  cards: z
    .array(
      z.object({
        id: z.string().uuid("ID do card inválido."),
        position: z
          .number()
          .int()
          .min(0, "Posição deve ser maior ou igual a 0."),
        columnId: z.string().uuid("ID da coluna inválido."),
      }),
    )
    .min(1, "Deve haver pelo menos um card para reordenar."),
});

export { reorderKanbanCardsSchema };
