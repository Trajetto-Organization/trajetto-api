import { z } from "zod";

const listTrafficViolationCodeSchema = z.object({
  page: z.coerce
    .number()
    .min(1, "Página deve ser maior que 0")
    .default(1)
    .describe("Página, a partir de 1."),
  pageSize: z.coerce
    .number()
    .min(1, "Tamanho da página deve ser maior que 0")
    .max(100, "Tamanho máximo da página é 100")
    .default(10)
    .describe("Itens por página, de 1 a 100."),
  search: z.string().optional().describe("Texto livre de busca."),
  gravity: z
    .enum(["LIGHT", "MEDIUM", "SERIOUS", "VERY_SERIOUS", "NO_POINTS"])
    .optional()
    .describe("Só infrações desta gravidade."),
  violatorType: z
    .string()
    .optional()
    .describe("Só infrações deste tipo de infrator."),
});

export { listTrafficViolationCodeSchema };
