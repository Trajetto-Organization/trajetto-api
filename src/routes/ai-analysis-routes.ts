import { FastifyInstance } from "fastify";

import { RequestRecordAnalysisController } from "@/modules/ai-analysis/usecases/request-record-analysis/request-record-analysis-controller";
import { GetAnalysisProgressController } from "@/modules/ai-analysis/usecases/get-analysis-progress/get-analysis-progress-controller";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";

import {
  aiAnalysisSchemas,
  aiAnalysisResponses,
} from "./documentation/ai-analysis-documentation";

const requestRecordAnalysisController = new RequestRecordAnalysisController();
const getAnalysisProgressController = new GetAnalysisProgressController();

async function aiAnalysisRoutes(app: FastifyInstance) {
  app.post(
    "/request/:recordType/:recordId",
    {
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      onRequest: [ensureAuthenticated],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["ai-analysis"],
        summary: "Request AI verification for an existing record",
        description:
          "Starts (or revives) the AI verification of a fuel/checklist record — the path for records created before the company had AI quota, quota-denied skips and failed runs. Idempotent per record + input: units already analyzed are never re-billed. Tenant-guarded by the record's business.",
        params: aiAnalysisSchemas.recordParams,
        response: {
          200: aiAnalysisResponses.analysisRequested,
          400: aiAnalysisResponses.analysisErrors,
          404: aiAnalysisResponses.analysisErrors,
          500: aiAnalysisResponses.internalServerError,
        },
      },
    },
    requestRecordAnalysisController.handle,
  );

  app.get(
    "/progress/:recordType/:recordId",
    {
      onRequest: [ensureAuthenticated],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["ai-analysis"],
        summary: "Durable progress of the latest AI analysis for a record",
        description:
          "Websocket events carry the live progress but die with the page; this endpoint lets the UI restore 'X of Y photos analyzed' after a refresh. Returns status 'none' when the record never had an analysis.",
        params: aiAnalysisSchemas.recordParams,
        response: {
          200: aiAnalysisResponses.analysisProgress,
          400: aiAnalysisResponses.analysisErrors,
          500: aiAnalysisResponses.internalServerError,
        },
      },
    },
    getAnalysisProgressController.handle,
  );
}

export { aiAnalysisRoutes };
