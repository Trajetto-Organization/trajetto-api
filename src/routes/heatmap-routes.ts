import { FastifyInstance } from "fastify";
import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";

import { verifyPermission } from "@/modules/middlewares/verify-permission";
import { GenerateHeatmapController } from "@/modules/heatmap/usecases/generate-heatmap/generate-heatmap-controller";

import {
  heatmapSchemas,
  heatmapResponses,
} from "./documentation/heatmap-documentation";

const generateHeatmapController = new GenerateHeatmapController();

async function heatmapRoutes(app: FastifyInstance) {
  // POST /heatmap/generate - Generate heatmap
  app.post(
    "/generate",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("fleet_analytics_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["heatmap"],
        summary: "Generate heatmap",
        description:
          "Generates a heatmap asynchronously (fines, fuel, or maintenance). Returns immediately and processes the heatmap in the background.",
        body: heatmapSchemas.generateHeatmap,
        response: {
          202: heatmapResponses.heatmapProcessing,
          400: heatmapResponses.generateHeatmapErrors,
          403: heatmapResponses.generateHeatmapErrors,
          500: heatmapResponses.generateHeatmapErrors,
        },
      },
    },
    generateHeatmapController.handle,
  );
}

export { heatmapRoutes };
