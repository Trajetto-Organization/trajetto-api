import { z } from "zod";

const updateDeleteAccountPayableSchema = z.object({
  accountPayableId: z.string().min(1, "O ID da conta a pagar é obrigatório!"),
});

export { updateDeleteAccountPayableSchema };
