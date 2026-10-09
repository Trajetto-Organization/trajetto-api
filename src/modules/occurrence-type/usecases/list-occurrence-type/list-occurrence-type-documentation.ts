import { z } from "zod";

import { searchMetaDoc } from "@/shared/pagination/list-meta";

/**
 * The listing's `meta.searchMeta`, as summarizeOccurrenceTypeList builds it:
 * each card counted with the search and the OTHER filters, never its own.
 */
const occurrenceTypeListSearchMetaDoc = searchMetaDoc(
  {
    total: z
      .number()
      .int()
      .describe("Tipos da busca com os filtros de impeditiva e foto, sem o de status."),
    active: z.number().int().describe("Destes, os ativos."),
    blocking: z
      .number()
      .int()
      .describe("Impeditivos, com a busca e os filtros de status e foto."),
    requiringPhoto: z
      .number()
      .int()
      .describe("Que exigem foto, com a busca e os filtros de status e impeditiva."),
  },
  ["status", "blocking", "photo", "category"],
);

export { occurrenceTypeListSearchMetaDoc };
