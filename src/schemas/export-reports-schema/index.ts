import { z } from "zod";

const exportReports = z.object({
  search: z.string().optional(),
  format: z.enum(["csv", "excel"]).optional().default("csv"),
});

export { exportReports };
