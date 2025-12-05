import { z } from "zod";

const listFuelByVehicleParamsSchema = z.object({
  vehicleId: z.string().uuid("O ID do veículo deve ser um UUID válido!"),
});

const listFuelByVehicleQuerySchema = z.object({
  page: z
    .string()
    .transform((val) => Number(val) || 1)
    .refine((num) => num >= 1, "A página é obrigatória!"),
  pageSize: z
    .string()
    .transform((val) => Number(val) || 10)
    .refine((num) => num >= 1, "A quantidade de páginas é obrigatória!"),
});

export { listFuelByVehicleParamsSchema, listFuelByVehicleQuerySchema };
