import { z } from "zod";

const updateDeleteAccountPayableSchema = z.object({
  accountPayableId: z
    .string({ required_error: "ID da conta a pagar é obrigatório!" })
    .uuid("ID da conta a pagar é inválido."),
});

export { updateDeleteAccountPayableSchema };
