import { z } from "zod";

import { MAX_PAGE_SIZE } from "@/shared/pagination/page-size";

const cursorPaginationSchema = z.object({
  limit: z
    .string()
    .regex(/^\d+$/, "O limite deve conter apenas dígitos.")
    .optional()
    .transform((val) => (val ? parseInt(val, 10) : 10))
    .refine(
      (val) => Number.isInteger(val) && val >= 1 && val <= MAX_PAGE_SIZE,
      {
        message: `O limite deve ser um inteiro entre 1 e ${MAX_PAGE_SIZE}.`,
      },
    )
    .describe(`Itens por página, de 1 a ${MAX_PAGE_SIZE}; padrão 10.`),
  cursor: z
    .string()
    .uuid("Cursor inválido.")
    .optional()
    .describe(
      "O `meta.searchMeta.nextCursor` da página anterior; vazio na primeira.",
    ),
  search: z
    .string()
    .trim()
    .max(100, "A busca deve ter no máximo 100 caracteres.")
    .optional()
    .transform((value) => value || undefined)
    .describe("Texto livre, até 100 caracteres."),
});

const cursorPaginationByBusinessSchema = cursorPaginationSchema.extend({
  businessId: z
    .string()
    .uuid("ID da empresa é inválido.")
    .describe("A empresa listada; fora do MASTER, só a do próprio usuário."),
});

export { cursorPaginationSchema, cursorPaginationByBusinessSchema };
