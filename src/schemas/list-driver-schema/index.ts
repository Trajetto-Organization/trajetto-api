import { z } from "zod";

import { listPagesSchema } from "@/schemas/list-pages-schema";
import { exportReports } from "@/schemas/export-reports-schema";

import {
  facetField,
  idFacetField,
  sortFields,
} from "@/shared/pagination/list-query";

import {
  CNH_CATEGORY_FACET_VALUES,
  DRIVER_CONTRACT_TYPES,
  DRIVER_SORT_FALLBACK,
  DRIVER_SORT_KEYS,
  DRIVER_STATUSES,
} from "@/modules/driver/usecases/list-driver/driver-list";

/**
 * The driver list's querystring, mirrored by the web
 * (src/features/driver/server-table.ts): one param per facet, sort and order
 * against the columns the database can order by (decision 8.8).
 */
const driverListFilterFields = {
  businessId: z
    .string()
    .uuid("ID da empresa é inválido.")
    .optional()
    .describe(
      "Só o MASTER envia: escolhe a empresa. Ausente, a empresa do usuário autenticado é usada.",
    ),
  ...sortFields(DRIVER_SORT_KEYS, DRIVER_SORT_FALLBACK),
  status: facetField(DRIVER_STATUSES, "Situação do motorista."),
  contract_type: facetField(DRIVER_CONTRACT_TYPES, "Tipo de contrato."),
  cnh_category: facetField(
    CNH_CATEGORY_FACET_VALUES,
    "Categoria da CNH; NONE = sem categoria informada.",
  ),
  branchId: idFacetField("Filiais."),
};

const listDriverSchema = listPagesSchema.extend(driverListFilterFields);

/** The export takes the list's filter and order, without paging (decision 5.8). */
const exportDriverSchema = exportReports.extend(driverListFilterFields);

export { exportDriverSchema, listDriverSchema };
