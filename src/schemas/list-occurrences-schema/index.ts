import { z } from "zod";
import { listPagesSchema } from "@/schemas/list-pages-schema";

import {
  facetField,
  idFacetField,
  sortFields,
} from "@/shared/pagination/list-query";

import {
  OCCURRENCE_DELIVERY_STATUSES,
  OCCURRENCE_FEED_CATEGORIES,
  OCCURRENCE_SEVERITIES,
  OCCURRENCE_SORT_FALLBACK,
  OCCURRENCE_SORT_KEYS,
} from "@/modules/delivery/usecases/list-occurrences/occurrence-feed";

const listOccurrencesSchema = listPagesSchema.extend({
  businessId: z
    .string()
    .uuid("ID da empresa é inválido.")
    .optional()
    .describe(
      "Só o MASTER envia: escolhe a empresa. Ausente, a empresa do usuário autenticado é usada.",
    ),
  ...sortFields(OCCURRENCE_SORT_KEYS, OCCURRENCE_SORT_FALLBACK),
  severity: facetField(
    OCCURRENCE_SEVERITIES,
    "Gravidade: blocking = tipo que impede a entrega; informational = só registro. Só casa ocorrências de não entrega.",
  ),
  category: facetField(
    OCCURRENCE_FEED_CATEGORIES,
    "Categoria (decisão 14.3): DELIVERED = entrega comprovada; NOT_DELIVERED = ocorrência de não entrega.",
  ),
  occurrenceTypeId: idFacetField("Tipos de ocorrência."),
  deliveryStatus: facetField(
    OCCURRENCE_DELIVERY_STATUSES,
    "Status atual da entrega da ocorrência.",
  ),
});

export { listOccurrencesSchema };
