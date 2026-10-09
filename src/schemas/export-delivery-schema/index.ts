import { z } from "zod";

import { facetField, idFacetField } from "@/shared/pagination/list-query";

import { deliveryListFilterFields } from "@/schemas/list-delivery-schema";
import {
  OCCURRENCE_DELIVERY_STATUSES,
  OCCURRENCE_FEED_CATEGORIES,
  OCCURRENCE_SEVERITIES,
} from "@/modules/delivery/usecases/list-occurrences/occurrence-feed";

/**
 * What every delivery export takes: the format, the search, and the company,
 * because the MASTER exports on behalf of the one selected on screen.
 */
const exportBaseFields = {
  search: z
    .string()
    .optional()
    .describe("A mesma busca da listagem; vazio exporta tudo."),
  format: z
    .enum(["csv", "excel"])
    .optional()
    .default("csv")
    .describe("`csv` (padrão) ou `excel` (.xlsx)."),

  businessId: z
    .string()
    .uuid("ID da empresa é inválido.")
    .optional()
    .describe(
      "Só o MASTER envia: escolhe a empresa (sem ele, 400 BUSINESS_NOT_IDENTIFIED). Ausente, a empresa do usuário autenticado é usada.",
    ),
};

/**
 * The deliveries export: the listing's own filters (decision 5.8), so the file
 * is what the screen shows. `status` takes one or more values, like the list.
 */
const exportDeliverySchema = z.object({
  ...exportBaseFields,
  ...deliveryListFilterFields,
});

/** The occurrences export: the occurrence feed's own filters. */
const exportOccurrenceSchema = z.object({
  ...exportBaseFields,
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

export { exportDeliverySchema, exportOccurrenceSchema };
