import { z } from "zod";

import { catalogLeaderDoc } from "@/shared/pagination/catalog-usage";

/** The listing's `meta.searchMeta`, as summarizeFuelTypeList builds it. */
const fuelTypeListSearchMetaDoc = z.object({
  total: z
    .number()
    .int()
    .describe("Tipos de combustível da busca (o mesmo total do paginador)."),
  vehicles: z
    .number()
    .int()
    .describe("Veículos cadastrados com esses combustíveis."),
  withoutVehicles: z
    .number()
    .int()
    .describe("Desses tipos, os que nenhum veículo usa."),
  mostUsed: catalogLeaderDoc(
    "Veículos cadastrados com o combustível.",
  ).describe(
    "O combustível com mais veículos (empate: ordem alfabética); null se nenhum veículo usa os tipos da busca.",
  ),
  month: z
    .object({
      month: z
        .string()
        .describe("O mês de negócio da empresa (AAAA-MM, no fuso dela)."),
      refuelings: z
        .number()
        .int()
        .describe("Abastecimentos do mês com esses combustíveis."),
      liters: z.number().describe("Litros abastecidos no mês."),
      amount: z.number().describe("Valor pago no mês (R$)."),
      mostRefueled: z
        .object({
          id: z.string(),
          label: z.string(),
          refuelings: z.number().int(),
          liters: z.number(),
          averagePricePerLiter: z
            .number()
            .describe(
              "Valor pago ÷ litros do combustível no mês (média ponderada).",
            ),
        })
        .nullable()
        .describe(
          "O combustível com mais litros no mês; null sem abastecimento.",
        ),
    })
    .nullable()
    .describe(
      "Abastecimentos do mês corrente. null quando a empresa não contratou Gestão de Frotas ou o perfil não lê Abastecimentos (`fuel_manage`).",
    ),
});

export { fuelTypeListSearchMetaDoc };
