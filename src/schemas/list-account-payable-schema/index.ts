import { z } from "zod";
import { listPagesSchema } from "@/schemas/list-pages-schema";

import { facetField, sortFields } from "@/shared/pagination/list-query";

import {
  ACCOUNT_PAYABLE_CATEGORIES,
  ACCOUNT_PAYABLE_SORT_FALLBACK,
  ACCOUNT_PAYABLE_SORT_KEYS,
} from "@/modules/account-payable/usecases/list-account-payable/account-payable-list";
import { ACCOUNT_PAYABLE_STATUS_GROUPS } from "@/modules/account-payable/rules/account-payable-status";

/**
 * The pickers' cap (cursor-pagination-schema): the term becomes several
 * ILIKE patterns over joined tables, so an unbounded one is not free.
 */
const searchField = z
  .string()
  .max(100, "A busca deve ter no máximo 100 caracteres.")
  .optional();

const accountPayableFilterFields = {
  businessId: z
    .string()
    .uuid("ID da empresa é inválido.")
    .optional()
    .describe(
      "Só o MASTER envia (e precisa enviar): escolhe a empresa. Ausente, a empresa do usuário autenticado é usada.",
    ),
  ...sortFields(ACCOUNT_PAYABLE_SORT_KEYS, ACCOUNT_PAYABLE_SORT_FALLBACK),
  status: facetField(
    ACCOUNT_PAYABLE_STATUS_GROUPS,
    "Situação pelo dia de negócio da empresa: OPEN (em aberto, vencimento hoje ou depois), OVERDUE (vencida e não quitada), PAID (quitada).",
  ),
  category: facetField(ACCOUNT_PAYABLE_CATEGORIES, "Categoria da conta."),
};

const listAccountPayableSchema = listPagesSchema.extend({
  search: searchField.describe(
    "Texto livre, até 100 caracteres, sem diferenciar maiúsculas.",
  ),
  ...accountPayableFilterFields,
});

/** The list's filters, without paging, plus the file format. */
const exportAccountPayableSchema = z.object({
  search: searchField.describe(
    "Filtra como a busca da listagem (até 100 caracteres); vazio exporta tudo.",
  ),
  ...accountPayableFilterFields,
  format: z
    .enum(["csv", "excel"])
    .optional()
    .default("csv")
    .describe("`csv` (padrão) ou `excel` (.xlsx)."),
});

export { exportAccountPayableSchema, listAccountPayableSchema };
