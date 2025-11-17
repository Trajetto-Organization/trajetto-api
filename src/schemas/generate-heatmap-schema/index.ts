import { z } from "zod";

const generateHeatmapSchema = z.object({
  businessId: z.string().uuid("O ID da empresa deve ser um UUID válido."),
  heatmapType: z.enum(["fines", "fuel", "maintenance"], {
    errorMap: () => ({
      message:
        "Tipo de heatmap inválido. Valores permitidos: fines, fuel, maintenance",
    }),
  }),
  startDate: z.coerce.date({
    errorMap: () => ({
      message: "Data de início inválida. Use o formato ISO 8601.",
    }),
  }),
  endDate: z.coerce.date({
    errorMap: () => ({
      message: "Data de fim inválida. Use o formato ISO 8601.",
    }),
  }),
  vehicleId: z.string().uuid().optional(),
  filters: z
    .object({
      fineType: z.string().optional(),
      fuelType: z.string().optional(),
      maintenanceType: z.enum(["INTERNAL", "EXTERNAL"]).optional(),
    })
    .optional(),
});

export { generateHeatmapSchema };
