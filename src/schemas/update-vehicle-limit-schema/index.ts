import { z } from "zod";
import { tenantLockedShape } from "@/shared/validation/tenant-locked-field";

const updateVehicleLimitSchema = z.object({
  ...tenantLockedShape,
  vehicle_limit: z
    .number()
    .int("O limite deve ser um número inteiro.")
    .min(0, "O limite não pode ser negativo.")
    .max(100000, "O limite não pode exceder 100.000 veículos.")
    .describe(
      "Nº de veículos contratados (base de cobrança por veículo; 0 = não configurado, nunca bloqueia).",
    ),
});

export { updateVehicleLimitSchema };
