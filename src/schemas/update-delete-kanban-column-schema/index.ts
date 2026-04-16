import { z } from "zod";

const updateDeleteKanbanColumnSchema = z.object({
  columnId: z
    .string({ required_error: "ID da coluna é obrigatório!" })
    .uuid("ID da coluna é inválido."),
  businessId: z
    .string({ required_error: "ID da empresa é obrigatório!" })
    .uuid("ID da empresa é inválido."),
});

export { updateDeleteKanbanColumnSchema };
