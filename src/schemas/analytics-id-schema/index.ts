import { z } from "zod";

const analyticsIdSchema = z.object({
  analyticsId: z
    .string()
    .uuid("O ID da análise deve ser um UUID válido.")
    .min(1, "O ID da análise é obrigatório."),
});

export { analyticsIdSchema };
