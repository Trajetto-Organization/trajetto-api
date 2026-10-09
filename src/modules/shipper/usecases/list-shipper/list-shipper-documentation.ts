import { z } from "zod";

import { searchMetaDoc } from "@/shared/pagination/list-meta";

/**
 * The listing's `meta.searchMeta`, as summarizeShipperList builds it: the
 * cards (with the search, without the Status filter) and the Status options.
 */
const shipperListSearchMetaDoc = searchMetaDoc(
  {
    total: z
      .number()
      .int()
      .describe("Embarcadores da busca, sem o filtro de status (cartão Total)."),
    active: z.number().int().describe("Destes, os ativos."),
    withCnpj: z.number().int().describe("Destes, os que têm CNPJ."),
  },
  ["status"],
);

export { shipperListSearchMetaDoc };
