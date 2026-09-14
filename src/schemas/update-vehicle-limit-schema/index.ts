import { z } from "zod";

const updateVehicleLimitSchema = z.object({
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
