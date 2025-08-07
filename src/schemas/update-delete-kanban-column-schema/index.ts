import { z } from "zod";

const updateDeleteKanbanColumnSchema = z.object({
  columnId: z.string().uuid("ID da coluna inválido."),
  businessId: z.string().uuid("ID da empresa inválido."),
});

export { updateDeleteKanbanColumnSchema };
