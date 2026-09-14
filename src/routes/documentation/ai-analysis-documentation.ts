import { z } from "zod";

const aiAnalysisSchemas = {
  recordParams: z.object({
    recordType: z
      .enum(["fuel", "checklist"])
      .describe("Tipo do registro a verificar."),
    recordId: z.string().uuid().describe("ID do registro (fuel ou checklist)."),
  }),
};

const aiAnalysisResponses = {
  analysisRequested: z.object({
    outcome: z
      .string()
      .describe("queued | already_running | already_completed"),
    message: z.string(),
  }),
  analysisProgress: z.object({
    data: z.object({
      status: z
        .string()
        .describe(
          "none | PENDING | PROCESSING | COMPLETED | PARTIAL | FAILED | SKIPPED",
        ),
      unitsTotal: z
        .number()
        .describe("Fotos/campos que esta análise cobra (unidades)."),
      unitsCompleted: z
        .number()
        .describe("Unidades já analisadas com sucesso."),
      attempts: z.number(),
      availableAt: z
        .string()
        .nullable()
        .describe("Quando a próxima tentativa fica elegível (se PENDING)."),
      lastError: z.string().nullable(),
    }),
  }),
  analysisErrors: z.object({
    message: z.string(),
  }),
  internalServerError: z.object({
    message: z.string().default("Erro interno do servidor."),
  }),
};

export { aiAnalysisSchemas, aiAnalysisResponses };
