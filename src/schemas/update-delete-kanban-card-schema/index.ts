import { z } from "zod";

const updateDeleteKanbanCardSchema = z.object({
  cardId: z
    .string({ required_error: "ID do card é obrigatório!" })
    .uuid("ID do card é inválido."),
});

export { updateDeleteKanbanCardSchema };
