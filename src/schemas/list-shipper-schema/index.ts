import { z } from "zod";
import { listPagesSchema } from "@/schemas/list-pages-schema";

import { facetField, sortFields } from "@/shared/pagination/list-query";
import { ACTIVE_STATUSES } from "@/shared/delivery/catalog-list";

import {
  SHIPPER_SORT_FALLBACK,
  SHIPPER_SORT_KEYS,
} from "@/modules/shipper/usecases/list-shipper/shipper-list";

const listShipperSchema = listPagesSchema.extend({
  businessId: z
    .string()
    .uuid("ID da empresa é inválido.")
    .optional()
    .describe(
      "Só o MASTER envia: escolhe a empresa. Ausente, a empresa do usuário autenticado é usada.",
    ),
  ...sortFields(SHIPPER_SORT_KEYS, SHIPPER_SORT_FALLBACK),
  status: facetField(ACTIVE_STATUSES, "Status do embarcador (active = ativo)."),
});

export { listShipperSchema };
