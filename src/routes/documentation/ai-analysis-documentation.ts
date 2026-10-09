import { z } from "zod";

import {
  PROGRESS_ERROR_CODES,
  type ProgressErrorCode,
} from "@/modules/ai-analysis/usecases/get-analysis-progress/progress-error";

import { errorResponse } from "./common-responses";

const aiAnalysisSchemas = {
  recordParams: z.object({
    recordType: z
      .enum(["fuel", "checklist"])
      .describe("Tipo do registro: abastecimento (fuel) ou checklist."),
    recordId: z.string().uuid().describe("ID do registro."),
  }),
};

const aiAnalysisResponses = {
  analysisRequested: z.object({
    outcome: z
      .enum(["queued", "already_running", "already_completed"])
      .describe(
        "queued: análise enfileirada. already_running: já em andamento. already_completed: as fotos atuais já foram lidas (nada é cobrado de novo).",
      ),
    message: z.string(),
  }),
  analysisProgress: z.object({
    data: z.object({
      status: z
        .enum([
          "none",
          "PENDING",
          "PROCESSING",
          "COMPLETED",
          "PARTIAL",
          "FAILED",
          "SKIPPED",
        ])
        .describe(
          "Estado da análise mais recente do registro; none quando nunca houve análise.",
        ),
      unitsTotal: z
        .number()
        .describe("Fotos que esta análise cobra (uma unidade da cota por foto)."),
      unitsCompleted: z
        .number()
        .describe("Fotos já lidas com sucesso."),
      attempts: z.number(),
      availableAt: z
        .string()
        .nullable()
        .describe("Quando a próxima tentativa fica elegível (se PENDING)."),
      lastErrorCode: z
        .enum(PROGRESS_ERROR_CODES as [ProgressErrorCode, ...ProgressErrorCode[]])
        .nullable()
        .describe(
          "Por que a análise espera ou como terminou: AI_PROVIDER_PAUSED (o provedor de IA recusou o serviço; retoma sozinha), AI_INPUT_SUPERSEDED (a foto ou o valor mudou antes da leitura; o registro atual tem a própria análise), AI_QUOTA_EXCEEDED (limite do período atingido), AI_INVALID_RESPONSE (o modelo respondeu fora do formato) ou AI_ANALYSIS_ERROR (outra falha da leitura). null quando não há erro.",
        ),
      lastError: z
        .string()
        .nullable()
        .describe(
          "Frase em português para `lastErrorCode`, para mostrar a quem está usando. Nunca é o texto de erro do provedor.",
        ),
      paused: z
        .boolean()
        .describe(
          "true quando a análise está PENDING porque o provedor de IA recusou o serviço (limite de gasto ou de uso, credencial): nada é lido nem cobrado até ele voltar, e a leitura é retomada automaticamente. A tela consulta com menos frequência enquanto isso.",
        ),
      aiEnabled: z
        .boolean()
        .describe(
          "A empresa do registro tem a leitura por IA ligada (limite maior que zero e provedor configurado).",
        ),
      canRequest: z
        .boolean()
        .describe(
          "Quem pergunta pode pedir uma nova leitura: permissão de escrita do registro, não é motorista e a IA está ligada.",
        ),
    }),
  }),
  /** Every refusal, in the shape the error handler sends. */
  error: errorResponse,
};

export { aiAnalysisSchemas, aiAnalysisResponses };
