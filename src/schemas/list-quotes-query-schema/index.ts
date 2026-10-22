import { listPagesSchema } from "@/schemas/list-pages-schema";

import { facetField, sortFields } from "@/shared/pagination/list-query";

import {
  QUOTE_FLEET_SIZES,
  QUOTE_SORT_FALLBACK,
  QUOTE_SORT_KEYS,
  QUOTE_STATUSES,
} from "@/modules/quote/usecases/list-quotes/quote-list";

/**
 * The quotes table's querystring (decision 8.8): the order and the filters
 * are answered over every quote, not over the rows of a page. `status`
 * accepts one or more stages (a single value, as before, still works).
 */
const listQuotesQuerySchema = listPagesSchema.extend({
  ...sortFields(QUOTE_SORT_KEYS, QUOTE_SORT_FALLBACK),
  status: facetField(
    QUOTE_STATUSES,
    "Estágio do orçamento: PENDING, CONTACTED, CLOSED ou CONVERTED.",
  ),
  fleet_size: facetField(
    QUOTE_FLEET_SIZES,
    "Tamanho da frota informado no pedido.",
  ),
});

export { listQuotesQuerySchema };
