import { z } from "zod";
import { fieldError } from "@/shared/validation/field-error";

const updateDeleteKanbanCardSchema = z.object({
  cardId: z
    .string(fieldError({ required: "ID do card é obrigatório!" }))
    .uuid("ID do card é inválido."),
});

export { updateDeleteKanbanCardSchema };
