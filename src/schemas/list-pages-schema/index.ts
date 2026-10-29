import { z } from "zod";

import { pageField, pageSizeField } from "@/shared/pagination/page-size";

const listPagesSchema = z.object({
  page: pageField(),
  pageSize: pageSizeField(2),
  search: z
    .string()
    .optional()
    .describe(
      "Texto livre, sem diferenciar maiúsculas, nos campos de busca da listagem.",
    ),
});

export { listPagesSchema };
