import { z } from "zod";
import { fieldError } from "@/shared/validation/field-error";

const updateDeletePartSchema = z.object({
  partId: z
    .string(fieldError({ required: "ID da peça é obrigatório!" }))
    .uuid("ID da peça é inválido."),
});

export { updateDeletePartSchema };
