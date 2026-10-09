import { FastifyInstance } from "fastify";

import { RequestRecordAnalysisController } from "@/modules/ai-analysis/usecases/request-record-analysis/request-record-analysis-controller";
import { GetAnalysisProgressController } from "@/modules/ai-analysis/usecases/get-analysis-progress/get-analysis-progress-controller";
import { verifyRecordPermission } from "@/modules/ai-analysis/usecases/shared/ai-record-access";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { requireModuleForPlugin } from "@/modules/middlewares/verify-module-enabled";

import {
  aiAnalysisSchemas,
  aiAnalysisResponses,
} from "./documentation/ai-analysis-documentation";

const requestRecordAnalysisController = new RequestRecordAnalysisController();
const getAnalysisProgressController = new GetAnalysisProgressController();

async function aiAnalysisRoutes(app: FastifyInstance) {
  // Readings of fleet records (fuelling odometer, checklist photos): gated
  // by the FLEET module like the records themselves (AI-1). A MASTER names
  // no company here; the use cases check the record's company.
  requireModuleForPlugin(app, "FLEET");

  app.post(
    "/request/:recordType/:recordId",
    {
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      onRequest: [ensureAuthenticated],
      preHandler: [verifyRecordPermission("write", { allowDriver: false })],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["ai-analysis"],
        summary: "Pede a verificação por IA de um registro existente",
        description:
          "Inicia (ou retoma) a leitura automática (IA local, ADR 0010) de um abastecimento ou checklist: registros criados antes de a empresa ter cota, pulados por falta de cota ou cuja análise falhou. Exige a permissão de escrita do registro (fuel_manage ou vehicle_checklist_manage, conforme `recordType`); motorista não pede. Só o odômetro é lido automaticamente: fotos de nível de combustível, pneus e itens de funcionamento não entram no pedido nem gastam cota. Idempotente: fotos já lidas nunca são cobradas de novo — num checklist, só as fotos ainda não lidas entram no pedido, e sem nenhuma a resposta é `already_completed` — e as leituras já feitas são comparadas de novo com os valores que o checklist tem agora, sem nova leitura nem cobrança. Registro de outra empresa responde 404, como um inexistente. Sem foto: 400 AI_RECORD_WITHOUT_PHOTO. IA desligada na empresa: 409 AI_NOT_ENABLED. Cota do mês esgotada: 409 AI_QUOTA_EXHAUSTED. Só fotos sem leitura automática: 409 AI_NOT_COVERED. Leitura desligada no servidor: 503 AI_PROVIDER_UNAVAILABLE.",
        params: aiAnalysisSchemas.recordParams,
        response: {
          200: aiAnalysisResponses.analysisRequested,
          400: aiAnalysisResponses.error,
          401: aiAnalysisResponses.error,
          403: aiAnalysisResponses.error,
          404: aiAnalysisResponses.error,
          409: aiAnalysisResponses.error,
          429: aiAnalysisResponses.error,
          500: aiAnalysisResponses.error,
          503: aiAnalysisResponses.error,
        },
      },
    },
    requestRecordAnalysisController.handle,
  );

  app.get(
    "/progress/:recordType/:recordId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyRecordPermission("read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["ai-analysis"],
        summary: "Andamento da última análise por IA de um registro",
        description:
          "Os eventos em tempo real levam o andamento, mas morrem com a página; esta rota devolve 'X de Y fotos analisadas' depois de recarregar, e diz se quem pergunta pode pedir uma nova leitura (`canRequest`). `paused` diz que a leitura espera o provedor de IA voltar (limite de gasto ou de uso); `lastErrorCode` e `lastError` dizem por que espera ou como terminou, com uma frase nossa — nunca o texto de erro do provedor. Exige a permissão de leitura do registro; o motorista vê só os próprios registros. Registro de outra empresa, ou de outro motorista, responde 404. `status` é none quando o registro nunca teve análise.",
        params: aiAnalysisSchemas.recordParams,
        response: {
          200: aiAnalysisResponses.analysisProgress,
          400: aiAnalysisResponses.error,
          401: aiAnalysisResponses.error,
          403: aiAnalysisResponses.error,
          404: aiAnalysisResponses.error,
          429: aiAnalysisResponses.error,
          500: aiAnalysisResponses.error,
        },
      },
    },
    getAnalysisProgressController.handle,
  );
}

export { aiAnalysisRoutes };
