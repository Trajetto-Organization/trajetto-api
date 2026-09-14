import { z } from "zod";

import { MAX_PAGE_SIZE } from "@/shared/pagination/page-size";

const cursorPaginationSchema = z.object({
  limit: z
    .string()
    .regex(/^\d+$/, "O limite deve conter apenas dígitos.")
    .optional()
    .transform((val) => (val ? parseInt(val, 10) : 10))
    .refine((val) => Number.isInteger(val) && val >= 1 && val <= MAX_PAGE_SIZE, {
      message: `O limite deve ser um inteiro entre 1 e ${MAX_PAGE_SIZE}.`,
    }),
  cursor: z.string().uuid("Cursor inválido.").optional(),
  search: z
    .string()
    .trim()
    .max(100, "A busca deve ter no máximo 100 caracteres.")
    .optional()
    .transform((value) => value || undefined),
});

const cursorPaginationByBusinessSchema = cursorPaginationSchema.extend({
  businessId: z.string().uuid("ID da empresa é inválido."),
});

export { cursorPaginationSchema, cursorPaginationByBusinessSchema };
