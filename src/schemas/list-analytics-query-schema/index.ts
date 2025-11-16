import { z } from "zod";

const listAnalyticsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1).optional(),
  limit: z.coerce.number().int().positive().max(100).default(10).optional(),
  analyticsType: z
    .enum([
      "route_efficiency",
      "cost_analysis",
      "vehicle_utilization",
      "fuel_consumption",
      "maintenance_cost",
    ])
    .optional(),
  period: z.enum(["daily", "weekly", "monthly", "custom"]).optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

export { listAnalyticsQuerySchema };
