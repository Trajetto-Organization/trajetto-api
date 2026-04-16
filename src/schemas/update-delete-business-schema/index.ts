import { z } from "zod";

const updateDeleteBusinessSchema = z.object({
  businessId: z
    .string({ required_error: "ID da empresa é obrigatório!" })
    .uuid("ID da empresa é inválido."),
});

export { updateDeleteBusinessSchema };
