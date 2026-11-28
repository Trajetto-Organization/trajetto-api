import { z } from "zod";
import { fieldError } from "@/shared/validation/field-error";

const updateDeleteAccountPayableSchema = z.object({
  accountPayableId: z
    .string(fieldError({ required: "ID da conta a pagar é obrigatório!" }))
    .uuid("ID da conta a pagar é inválido."),
});

export { updateDeleteAccountPayableSchema };
