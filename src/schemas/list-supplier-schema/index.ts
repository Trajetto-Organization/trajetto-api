import { z } from "zod";
import { listPagesSchema } from "@/schemas/list-pages-schema";

import { facetField, sortFields } from "@/shared/pagination/list-query";

import {
  BRAZILIAN_UFS,
  SUPPLIER_SORT_FALLBACK,
  SUPPLIER_SORT_KEYS,
} from "@/modules/supplier/usecases/list-supplier/supplier-list";

const listSupplierSchema = listPagesSchema.extend({
  // The pickers' cap (cursor-pagination-schema): an ILIKE pattern per field.
  search: z
    .string()
    .max(100, "A busca deve ter no máximo 100 caracteres.")
    .optional()
    .describe("Texto livre, até 100 caracteres, sem diferenciar maiúsculas."),
  businessId: z
    .string()
    .uuid("ID da empresa é inválido.")
    .optional()
    .describe(
      "Só o MASTER envia (e precisa enviar): escolhe a empresa. Ausente, a empresa do usuário autenticado é usada.",
    ),
  ...sortFields(SUPPLIER_SORT_KEYS, SUPPLIER_SORT_FALLBACK),
  uf: facetField(BRAZILIAN_UFS, "Estado (UF) do endereço do fornecedor."),
});

export { listSupplierSchema };
