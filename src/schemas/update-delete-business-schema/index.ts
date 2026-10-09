import { z } from "zod";

const updateDeleteBusinessSchema = z.object({
  businessId: z
    .string({ required_error: "ID da empresa é obrigatório!" })
    .uuid("ID da empresa é inválido.")
    .describe("ID da empresa; fora do MASTER, só a do próprio usuário."),
});

export { updateDeleteBusinessSchema };
