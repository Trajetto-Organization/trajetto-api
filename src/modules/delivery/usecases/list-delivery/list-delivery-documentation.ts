import { z } from "zod";

import { searchMetaDoc } from "@/shared/pagination/list-meta";

/**
 * The listing's `meta.searchMeta`, as summarizeDeliveryList builds it: the
 * status cards and the options of the Status, Embarcador and Motorista
 * filters, each counted with every other filter applied, plus the period the
 * numbers cover.
 */
const deliveryListSearchMetaDoc = searchMetaDoc(
  {
    statusCounts: z
      .record(z.number().int())
      .describe(
        "Entregas por status com a busca e os demais filtros, sem o de status (os cartões).",
      ),
    period: z
      .object({
        from: z
          .string()
          .describe(
            "Primeiro dia do período (AAAA-MM-DD), no fuso da empresa.",
          ),
        to: z
          .string()
          .describe("Último dia do período (AAAA-MM-DD), incluído."),
        applied: z
          .boolean()
          .describe(
            "false quando a busca era exatamente o ID, o pedido, a chave ou o número da NF de uma entrega: o período foi ignorado e as linhas podem ser mais antigas.",
          ),
      })
      .nullable()
      .describe(
        "O período que a página e as contagens cobrem; null sem `period` (todas as datas).",
      ),
  },
  ["status", "shipperId", "driverId"],
);

export { deliveryListSearchMetaDoc };
