import { z } from "zod";

const exportReports = z.object({
  search: z
    .string()
    .optional()
    .describe("Filtra como a busca da listagem; vazio exporta tudo."),
  format: z
    .enum(["csv", "excel"])
    .optional()
    .default("csv")
    .describe("`csv` (padrão) ou `excel` (.xlsx)."),
});

export { exportReports };
