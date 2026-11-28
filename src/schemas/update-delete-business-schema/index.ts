import { z } from "zod";
import { fieldError } from "@/shared/validation/field-error";

const updateDeleteBusinessSchema = z.object({
  businessId: z
    .string(fieldError({ required: "ID da empresa é obrigatório!" }))
    .uuid("ID da empresa é inválido.")
    .describe("ID da empresa; fora do MASTER, só a do próprio usuário."),
});

export { updateDeleteBusinessSchema };
