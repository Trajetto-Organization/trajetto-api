import { z } from "zod";

const updateAILimitSchema = z.object({
  ai_analysis_limit: z
    .number()
    .int("O limite deve ser um número inteiro.")
    .min(0, "O limite não pode ser negativo.")
    .max(10000, "O limite não pode exceder 10.000 análises por mês."),
});

export { updateAILimitSchema };
