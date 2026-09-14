import { z } from "zod";

const searchChatMessagesSchema = z.object({
  businessId: z
    .string()
    .uuid("ID da empresa é inválido.")
    .optional()
    .describe(
      "Só o MASTER envia: escolhe a empresa. Ausente, a empresa do usuário autenticado é usada.",
    ),
  search: z
    .string()
    .trim()
    .min(2, "Informe ao menos 2 caracteres para buscar."),

  // Querystrings are strings; the transform hands the use case a number.
  limit: z
    .string()
    .optional()
    .transform((value) => {
      const parsed = Number(value);

      return Number.isFinite(parsed) && parsed >= 1 ? parsed : 30;
    })
    .refine((value) => value <= 100, "No máximo 100 resultados por busca."),
});

export { searchChatMessagesSchema };
