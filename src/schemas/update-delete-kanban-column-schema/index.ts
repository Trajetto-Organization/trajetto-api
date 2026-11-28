import { z } from "zod";
import { fieldError } from "@/shared/validation/field-error";

const updateDeleteKanbanColumnSchema = z.object({
  columnId: z
    .string(fieldError({ required: "ID da coluna é obrigatório!" }))
    .uuid("ID da coluna é inválido."),
  businessId: z
    .string(fieldError({ required: "ID da empresa é obrigatório!" }))
    .uuid("ID da empresa é inválido."),
});

export { updateDeleteKanbanColumnSchema };
