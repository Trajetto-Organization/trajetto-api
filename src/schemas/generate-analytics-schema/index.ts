import { z } from "zod";

const generateAnalyticsSchema = z.object({
  analyticsType: z.enum(
    [
      "route_efficiency",
      "cost_analysis",
      "vehicle_utilization",
      "fuel_consumption",
      "maintenance_cost",
    ],
    {
      errorMap: () => ({
        message:
          "Tipo de análise inválido. Valores permitidos: route_efficiency, cost_analysis, vehicle_utilization, fuel_consumption, maintenance_cost",
      }),
    },
  ),
  period: z.enum(["daily", "weekly", "monthly", "quarterly", "yearly", "custom"], {
    errorMap: () => ({
      message:
        "Período inválido. Valores permitidos: daily, weekly, monthly, quarterly, yearly, custom",
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
  businessId: z.string().uuid("O ID da empresa deve ser um UUID válido."),
  metadata: z.record(z.unknown()).optional(),
});

export { generateAnalyticsSchema };
