import { z } from "zod";

const activitySummarySchema = z.object({
  period: z
    .enum(["7d", "30d"])
    .default("7d")
    .describe("Janela do resumo: últimos 7 ou 30 dias."),
  businessId: z
    .string()
    .uuid("ID da empresa é inválido.")
    .optional()
    .describe(
      "Só o MASTER envia: recorta o resumo para uma empresa. Ausente, a empresa do usuário autenticado é usada.",
    ),
});

export { activitySummarySchema };
