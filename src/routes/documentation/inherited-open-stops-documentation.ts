import { z } from "zod";

/**
 * What a screen's number inherited from routes left open (plan of
 * 02/11/2026, H3; decision D26), the shape of the tower's `inherited`
 * (inheritedOpenStops): the operation summary and the deliveries list's
 * cards publish it for the note "inclui N de rotas abertas desde dd/mm".
 */
function inheritedOpenStopsDoc(deliveries: string, description: string) {
  return z
    .object({
      routes: z
        .number()
        .int()
        .describe(
          "Rotas esquecidas em andamento (saíram antes de hoje, no fuso da empresa, ou há mais de 16 h) com ao menos uma parada contada aqui.",
        ),
      deliveries: z.number().int().describe(deliveries),
      since: z
        .string()
        .nullable()
        .describe(
          "A saída mais antiga entre elas (instante ISO 8601, UTC); null quando não há nenhuma.",
        ),
    })
    .describe(description);
}

export { inheritedOpenStopsDoc };
