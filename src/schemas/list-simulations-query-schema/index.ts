import { z } from "zod";

const listSimulationsQuerySchema = z.object({
  page: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val, 10) : 1)),
  limit: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val, 10) : 10)),
  search: z.string().optional(),
  status: z
    .enum(["pending", "processing", "completed", "failed"])
    .optional(),
});

export { listSimulationsQuerySchema };
