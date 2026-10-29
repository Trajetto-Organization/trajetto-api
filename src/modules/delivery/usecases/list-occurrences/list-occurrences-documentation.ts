import { z } from "zod";

import { searchMetaDoc } from "@/shared/pagination/list-meta";

/**
 * The feed's `meta.searchMeta`, as summarizeOccurrenceFeed builds it: the
 * three cards and the options of the Gravidade and Tipo filters. The status
 * filter is a closed set the client labels itself, without counts.
 */
const occurrenceFeedSearchMetaDoc = searchMetaDoc(
  {
    total: z
      .number()
      .int()
      .describe(
        "Ocorrências da busca e dos demais filtros, sem o de gravidade (o total dos cartões).",
      ),
    blocking: z
      .number()
      .int()
      .describe("Das quais de tipo que impede a entrega."),
    informational: z
      .number()
      .int()
      .describe("Das quais só de registro, sem impacto na entrega."),
    delivered: z
      .number()
      .int()
      .describe(
        "Das quais entregas comprovadas (categoria DELIVERED, decisão 14.3); não entram nas gravidades.",
      ),
  },
  ["severity", "category", "occurrenceTypeId"],
);

export { occurrenceFeedSearchMetaDoc };
