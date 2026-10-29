import { z } from "zod";

import { listPagesSchema } from "@/schemas/list-pages-schema";
import { idFacetField, sortFields } from "@/shared/pagination/list-query";

import {
  PART_SORT_FALLBACK,
  PART_SORT_KEYS,
} from "@/modules/part/usecases/list-part/part-list";

const listPartSchema = listPagesSchema.extend({
  businessId: z
    .string()
    .uuid("ID da empresa é inválido.")
    .optional()
    .describe(
      "Só o MASTER envia: escolhe a empresa (obrigatório para ele). Ausente, a empresa do usuário autenticado é usada.",
    ),
  ...sortFields(PART_SORT_KEYS, PART_SORT_FALLBACK),
  supplierId: idFacetField("Fornecedores da peça."),
});

export { listPartSchema };
