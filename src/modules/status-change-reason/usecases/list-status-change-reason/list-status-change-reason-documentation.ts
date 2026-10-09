import { z } from "zod";

import { searchMetaDoc } from "@/shared/pagination/list-meta";

/**
 * The listing's `meta.searchMeta`, as summarizeStatusReasonList builds it:
 * the cards (with the search, without the Status filter) and its options.
 */
const statusReasonListSearchMetaDoc = searchMetaDoc(
  {
    total: z
      .number()
      .int()
      .describe("Motivos da busca, sem o filtro de status (cartão Total)."),
    active: z.number().int().describe("Destes, os ativos."),
    used: z
      .number()
      .int()
      .describe("Destes, os que já explicam alguma mudança de status (não podem ser excluídos)."),
  },
  ["status"],
);

export { statusReasonListSearchMetaDoc };
