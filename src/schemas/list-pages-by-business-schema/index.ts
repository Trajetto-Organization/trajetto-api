import { z } from "zod";

const listPagesByBusinessSchema = z.object({
  page: z
    .string()
    .transform((val) => Number(val) || 1)
    .refine((num) => num >= 1, "A página é obrigatória!"),
  pageSize: z
    .string()
    .transform((val) => Number(val) || 2)
    .refine((num) => num >= 1, "A quantidade de páginas é obrigatória!"),
  businessId: z
    .string({ required_error: "A empresa é obrigatória!" })
    .min(1, "A empresa é obrigatória!"),
  search: z
    .string()
    .optional()
    .describe(
      "Optional search term to filter vehicles by license plate, model, or brand",
    ),
});

export { listPagesByBusinessSchema };
