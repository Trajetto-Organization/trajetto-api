import { z } from "zod";

const listRecentActivitiesSchema = z.object({
  page: z
    .string()
    .transform((val) => Number(val) || 1)
    .refine((num) => num >= 1, "A página é obrigatória!"),
  pageSize: z
    .string()
    .transform((val) => Number(val) || 5)
    .refine((num) => num >= 1, "A quantidade de páginas é obrigatória!"),
  search: z.string().optional(),
});

export { listRecentActivitiesSchema };
