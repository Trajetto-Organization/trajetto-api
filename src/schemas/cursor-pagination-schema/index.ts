import { z } from "zod";

const cursorPaginationSchema = z.object({
  limit: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val) : 10)),
  cursor: z.string().optional(),
});

const cursorPaginationByBusinessSchema = cursorPaginationSchema.extend({
  businessId: z.string().uuid("ID da empresa é inválido."),
});

export { cursorPaginationSchema, cursorPaginationByBusinessSchema };
