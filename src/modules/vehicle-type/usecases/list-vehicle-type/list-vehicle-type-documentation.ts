import { z } from "zod";

import { catalogLeaderDoc } from "@/shared/pagination/catalog-usage";

/** The listing's `meta.searchMeta`, as summarizeVehicleTypeList builds it. */
const vehicleTypeListSearchMetaDoc = z.object({
  total: z.number().int().describe("Tipos da busca (o mesmo total do paginador)."),
  vehicles: z
    .number()
    .int()
    .describe("Veículos cadastrados com esses tipos (a soma da coluna Veículos)."),
  withoutVehicles: z
    .number()
    .int()
    .describe("Desses tipos, os que nenhum veículo usa (os únicos que podem ser excluídos)."),
  mostUsed: catalogLeaderDoc("Veículos cadastrados com o tipo.").describe(
    "O tipo com mais veículos (empate: ordem alfabética); null se nenhum veículo tem tipo.",
  ),
});

export { vehicleTypeListSearchMetaDoc };
