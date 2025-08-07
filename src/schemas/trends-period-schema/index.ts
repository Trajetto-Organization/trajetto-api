import { z } from "zod";

const trendsPeriodSchema = z.object({
  period: z.enum(["7d", "30d", "3m", "6m", "12m"]),
});

export { trendsPeriodSchema };
