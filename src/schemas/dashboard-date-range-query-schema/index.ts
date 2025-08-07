import { z } from "zod";

const dashboardDateRangeQuerySchema = z.object({
  startDate: z.string(),
  endDate: z.string(),
});

export { dashboardDateRangeQuerySchema };
