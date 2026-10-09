import { z } from "zod";

const listKanbanQuerySchema = z.object({
  page: z.coerce.number().min(1).optional().describe("Página, a partir de 1."),
  pageSize: z.coerce
    .number()
    .min(1)
    .max(100)
    .optional()
    .describe("Itens por página, de 1 a 100."),
  search: z.string().optional().describe("Texto livre de busca."),
});

export { listKanbanQuerySchema };
