import { z } from "zod";
import { listPagesSchema } from "@/schemas/list-pages-schema";

import {
  facetField,
  idFacetField,
  sortFields,
} from "@/shared/pagination/list-query";

import {
  DELIVERY_LIST_STATUSES,
  DELIVERY_SORT_FALLBACK,
  DELIVERY_SORT_KEYS,
} from "@/modules/delivery/usecases/list-delivery/delivery-list";

/**
 * The deliveries listing's querystring (decision 8.8): the page, the search,
 * the server-side sort and one param per facet — the same params the export
 * takes, so the file is what the screen shows (decision 5.8).
 */
const deliveryListFilterFields = {
  status: facetField(DELIVERY_LIST_STATUSES, "Status da entrega."),
  shipperId: idFacetField("Embarcadores."),
  driverId: idFacetField("Motoristas."),
};

const listDeliverySchema = listPagesSchema.extend({
  businessId: z
    .string()
    .uuid("ID da empresa é inválido.")
    .optional()
    .describe(
      "Só o MASTER envia: escolhe a empresa. Ausente, a empresa do usuário autenticado é usada.",
    ),
  ...sortFields(DELIVERY_SORT_KEYS, DELIVERY_SORT_FALLBACK),
  ...deliveryListFilterFields,
});

export { deliveryListFilterFields, listDeliverySchema };
