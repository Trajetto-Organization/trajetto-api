import { z } from "zod";

import { searchMetaDoc } from "@/shared/pagination/list-meta";

/**
 * The list's `meta.searchMeta`, as summarizeFuelList builds it: the four
 * cards over the whole filtered set and the options of the Filial, Veículo
 * and Combustível filters with their counts.
 */
const fuelListSearchMetaDoc = searchMetaDoc(
  {
    total: z
      .number()
      .int()
      .describe("Abastecimentos da busca e de todos os filtros (o cartão Total)."),
    totalLiters: z
      .number()
      .describe("Soma dos litros desses abastecimentos, com 3 casas."),
    totalAmount: z
      .number()
      .describe("Soma do valor total desses abastecimentos, em reais, com 2 casas."),
    verifiedOdometer: z
      .number()
      .int()
      .describe("Desses, quantos têm o odômetro verificado."),
  },
  ["branchId", "vehicleId", "fuelTypeId"],
);

export { fuelListSearchMetaDoc };
