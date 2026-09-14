import { z } from "zod";

import { pageSizeField } from "@/shared/pagination/page-size";

const listPagesSchema = z.object({
  page: z
    .string()
    .transform((val) => Number(val) || 1)
    .refine((num) => num >= 1, "A página é obrigatória!"),
  pageSize: pageSizeField(2),
  search: z.string().optional(),
});

export { listPagesSchema };
