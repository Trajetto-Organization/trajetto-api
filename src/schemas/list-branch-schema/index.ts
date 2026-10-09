import { z } from "zod";
import { listPagesSchema } from "@/schemas/list-pages-schema";

import { facetField, sortFields } from "@/shared/pagination/list-query";

import {
  BRANCH_SORT_FALLBACK,
  BRANCH_SORT_KEYS,
  BRANCH_STATUSES,
  BRAZILIAN_UFS,
} from "@/modules/branch/usecases/list-branch/branch-list";

const listBranchSchema = listPagesSchema.extend({
  businessId: z
    .string()
    .uuid("ID da empresa é inválido.")
    .optional()
    .describe(
      "Só o MASTER envia (e precisa enviar): escolhe a empresa. Ausente, a empresa do usuário autenticado é usada.",
    ),
  ...sortFields(BRANCH_SORT_KEYS, BRANCH_SORT_FALLBACK),
  status: facetField(BRANCH_STATUSES, "Situação da filial (active = ativa, inactive = inativa)."),
  uf: facetField(BRAZILIAN_UFS, "Estado (UF) do endereço da filial."),
});

export { listBranchSchema };
