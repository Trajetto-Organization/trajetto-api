import { z } from "zod";

const updateDeletePartSchema = z.object({
  partId: z
    .string({ required_error: "ID da peça é obrigatório!" })
    .uuid("ID da peça é inválido."),
});

export { updateDeletePartSchema };
