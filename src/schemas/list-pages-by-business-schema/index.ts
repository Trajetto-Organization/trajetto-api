import { z } from "zod";

import { pageSizeField } from "@/shared/pagination/page-size";

const listPagesByBusinessSchema = z.object({
  page: z
    .string()
    .transform((val) => Number(val) || 1)
    .refine((num) => num >= 1, "A página é obrigatória!"),
  pageSize: pageSizeField(2),
  businessId: z
    .string({ required_error: "ID da empresa é obrigatório!" })
    .uuid("ID da empresa é inválido."),
  search: z
    .string()
    .optional()
    .describe(
      "Optional search term to filter vehicles by license plate, model, or brand",
    ),
});

export { listPagesByBusinessSchema };
