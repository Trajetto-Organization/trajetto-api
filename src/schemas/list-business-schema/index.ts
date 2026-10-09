import { listPagesSchema } from "@/schemas/list-pages-schema";

import { facetField, sortFields } from "@/shared/pagination/list-query";

import {
  BRAZILIAN_UFS,
  BUSINESS_SORT_FALLBACK,
  BUSINESS_SORT_KEYS,
  BUSINESS_STATUSES,
} from "@/modules/business/usecases/list-business/business-list";

/**
 * The companies table's querystring (decision 8.8): order and filters are
 * answered over every company, not over the rows of a page.
 */
const listBusinessSchema = listPagesSchema.extend({
  ...sortFields(BUSINESS_SORT_KEYS, BUSINESS_SORT_FALLBACK),
  status: facetField(BUSINESS_STATUSES, "Situação da empresa (active = ativa, inactive = inativa)."),
  uf: facetField(BRAZILIAN_UFS, "Estado (UF) do endereço da empresa."),
});

export { listBusinessSchema };
