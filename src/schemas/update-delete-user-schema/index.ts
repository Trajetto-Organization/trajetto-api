import { z } from "zod";

const updateDeleteUserSchema = z.object({
  userId: z
    .string({ required_error: "ID do usuário é obrigatório!" })
    .uuid("ID do usuário é inválido."),
});

export { updateDeleteUserSchema };
