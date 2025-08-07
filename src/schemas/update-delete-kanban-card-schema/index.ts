import { z } from "zod";

const updateDeleteKanbanCardSchema = z.object({
  cardId: z.string().uuid("ID do card inválido."),
});

export { updateDeleteKanbanCardSchema };
