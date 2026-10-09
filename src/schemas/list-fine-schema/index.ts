import { z } from "zod";

import { listPagesSchema } from "@/schemas/list-pages-schema";
import {
  facetField,
  idFacetField,
  sortFields,
} from "@/shared/pagination/list-query";

import {
  FINE_SORT_FALLBACK,
  FINE_SORT_KEYS,
  FINE_STATUSES,
} from "@/modules/fine/usecases/list-fine/fine-list";

/**
 * Filters of GET /fines/list-fine, shared with GET /fines/export-fine so the
 * file holds exactly what the screen shows (decision 5.8).
 */
const listFineFilterFields = {
  businessId: z
    .string()
    .uuid("ID da empresa é inválido.")
    .optional()
    .describe(
      "Só o MASTER envia: escolhe a empresa. Ausente, a empresa do usuário autenticado é usada.",
    ),
  status: facetField(
    FINE_STATUSES,
    "Situação do pagamento no dia de negócio da empresa: PAID = com data de pagamento; PENDING = em aberto até o dia do vencimento; OVERDUE = em aberto depois do dia do vencimento.",
  ),
  branchId: idFacetField("Filiais."),
  trafficViolationCodeId: idFacetField("Códigos de infração."),
};

const listFineSchema = listPagesSchema.extend({
  ...listFineFilterFields,
  ...sortFields(FINE_SORT_KEYS, FINE_SORT_FALLBACK),
});

export { listFineSchema, listFineFilterFields };
