import { z } from "zod";

const listRoutesQuerySchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  search: z.string().optional(),
  status: z.string().optional(),
});

export { listRoutesQuerySchema };
