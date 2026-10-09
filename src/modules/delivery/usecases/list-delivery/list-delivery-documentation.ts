import { z } from "zod";

import { searchMetaDoc } from "@/shared/pagination/list-meta";

/**
 * The listing's `meta.searchMeta`, as summarizeDeliveryList builds it: the
 * status cards and the options of the Status, Embarcador and Motorista
 * filters, each counted with every other filter applied.
 */
const deliveryListSearchMetaDoc = searchMetaDoc(
  {
    statusCounts: z
      .record(z.number().int())
      .describe(
        "Entregas por status com a busca e os demais filtros, sem o de status (os cartões).",
      ),
  },
  ["status", "shipperId", "driverId"],
);

export { deliveryListSearchMetaDoc };
