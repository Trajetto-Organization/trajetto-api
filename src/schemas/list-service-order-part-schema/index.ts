import { z } from "zod";

import { listPagesSchema } from "@/schemas/list-pages-schema";
import { idFacetField, sortFields } from "@/shared/pagination/list-query";

import {
  SERVICE_ORDER_PART_SORT_FALLBACK,
  SERVICE_ORDER_PART_SORT_KEYS,
} from "@/modules/service-order-part/usecases/list-service-order-part/service-order-part-list";

const listServiceOrderPartSchema = listPagesSchema.extend({
  businessId: z
    .string()
    .uuid("ID da empresa é inválido.")
    .optional()
    .describe(
      "Só o MASTER envia: escolhe a empresa (obrigatório para ele). Ausente, a empresa do usuário autenticado é usada.",
    ),
  ...sortFields(SERVICE_ORDER_PART_SORT_KEYS, SERVICE_ORDER_PART_SORT_FALLBACK),
  partId: idFacetField("Peças do catálogo."),
  serviceOrderId: idFacetField(
    "Ordens de serviço (as peças de uma ordem). Filtro sem contagem.",
  ),
});

export { listServiceOrderPartSchema };
