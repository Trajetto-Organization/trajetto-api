import { z } from "zod";

const listVehicleChecklistBusinessSchema = z.object({
  businessId: z.string().uuid("O ID da empresa deve ser um UUID válido."),
});

const listVehicleChecklistBusinessQuerySchema = z.object({
  page: z
    .string()
    .transform((val) => Number(val))
    .pipe(z.number().min(1, "A página deve ser um número maior que 0."))
    .default("1"),
  pageSize: z
    .string()
    .transform((val) => Number(val))
    .pipe(
      z
        .number()
        .min(1, "O tamanho da página deve ser maior que 0.")
        .max(100, "O tamanho da página não pode exceder 100."),
    )
    .default("10"),
  search: z.string().optional(),
  vehicleId: z
    .string()
    .uuid("O ID do veículo deve ser um UUID válido.")
    .optional(),
  driverId: z
    .string()
    .uuid("O ID do motorista deve ser um UUID válido.")
    .optional(),
  overall_condition: z
    .enum(["approved", "approved_with_restrictions", "rejected"], {
      invalid_type_error:
        "Condição geral inválida. Deve ser 'approved', 'approved_with_restrictions' ou 'rejected'.",
    })
    .optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

export {
  listVehicleChecklistBusinessSchema,
  listVehicleChecklistBusinessQuerySchema,
};
