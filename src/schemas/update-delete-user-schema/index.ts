import { z } from "zod";
import { fieldError } from "@/shared/validation/field-error";

const updateDeleteUserSchema = z.object({
  userId: z
    .string(fieldError({ required: "ID do usuário é obrigatório!" }))
    .uuid("ID do usuário é inválido."),
});

export { updateDeleteUserSchema };
