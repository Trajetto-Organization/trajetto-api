import { z } from "zod";

const listKanbanQuerySchema = z.object({
  page: z.coerce.number().min(1).optional(),
  pageSize: z.coerce.number().min(1).max(100).optional(),
  search: z.string().optional(),
});

export { listKanbanQuerySchema };
