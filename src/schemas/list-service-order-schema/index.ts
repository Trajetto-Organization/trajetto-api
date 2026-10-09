import { z } from "zod";

import { listPagesSchema } from "@/schemas/list-pages-schema";
import { exportReports } from "@/schemas/export-reports-schema";

import {
  facetField,
  idFacetField,
  sortFields,
} from "@/shared/pagination/list-query";

import {
  MAINTENANCE_TYPES,
  SERVICE_ORDER_SORT_FALLBACK,
  SERVICE_ORDER_SORT_KEYS,
  SERVICE_ORDER_STATUSES,
} from "@/modules/service-order/usecases/list-service-order/service-order-list";

const businessIdQuery = z
  .string()
  .uuid("ID da empresa é inválido.")
  .optional()
  .describe(
    "Só o MASTER envia: escolhe a empresa (obrigatório para ele). Ausente, a empresa do usuário autenticado é usada.",
  );

/** The listing's filters, the same in the list and in the export (decision 5.8). */
const serviceOrderFilters = {
  businessId: businessIdQuery,
  status: facetField(
    SERVICE_ORDER_STATUSES,
    "Situação: open = sem data de conclusão; completed = concluída.",
  ),
  maintenanceType: facetField(
    MAINTENANCE_TYPES,
    "Onde o serviço é feito: INTERNAL (oficina própria) ou EXTERNAL (oficina de terceiro).",
  ),
  branchId: idFacetField("Filiais da ordem de serviço."),
};

const listServiceOrderSchema = listPagesSchema.extend({
  ...serviceOrderFilters,
  ...sortFields(SERVICE_ORDER_SORT_KEYS, SERVICE_ORDER_SORT_FALLBACK),
});

const exportServiceOrderSchema = exportReports.extend(serviceOrderFilters);

export { exportServiceOrderSchema, listServiceOrderSchema };
