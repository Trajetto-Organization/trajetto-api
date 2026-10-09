import { z } from "zod";
import { tenantLockedShape } from "@/shared/validation/tenant-locked-field";

const updateAILimitSchema = z.object({
  ...tenantLockedShape,
  ai_analysis_limit: z
    .number()
    .int("O limite deve ser um número inteiro.")
    .min(0, "O limite não pode ser negativo.")
    .max(10000, "O limite não pode exceder 10.000 análises por mês."),
});

export { updateAILimitSchema };
