import { z } from "zod";

const trendsPeriodSchema = z.object({
  period: z
    .enum(["7d", "30d", "3m", "6m", "12m"])
    .describe("Janela da série: 7 ou 30 dias, 3, 6 ou 12 meses."),
});

export { trendsPeriodSchema };
