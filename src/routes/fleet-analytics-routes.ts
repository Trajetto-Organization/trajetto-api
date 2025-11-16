import { FastifyInstance } from "fastify";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { verifyPermission } from "@/modules/middlewares/verify-permission";

import { GenerateAnalyticsController } from "@/modules/fleet-analytics/usecases/generate-analytics/generate-analytics-controller";
import { ListAnalyticsBusinessController } from "@/modules/fleet-analytics/usecases/list-analytics-business/list-analytics-business-controller";

import { GetAnalyticsController } from "@/modules/fleet-analytics/usecases/get-analytics/get-analytics-controller";
import { DeleteAnalyticsController } from "@/modules/fleet-analytics/usecases/delete-analytics/delete-analytics-controller";

import {
  fleetAnalyticsSchemas,
  fleetAnalyticsResponses,
} from "./documentation/fleet-analytics-documentation";

const generateAnalyticsController = new GenerateAnalyticsController();
const listAnalyticsController = new ListAnalyticsBusinessController();

const getAnalyticsController = new GetAnalyticsController();
const deleteAnalyticsController = new DeleteAnalyticsController();

async function fleetAnalyticsRoutes(app: FastifyInstance) {
  // POST /fleet-analytics/generate - Generate analytics (always async)
  app.post(
    "/generate",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("fleet_analytics_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["fleet-analytics"],
        summary: "Generate fleet analytics",
        description:
          "Generates fleet analytics asynchronously. Returns immediately and processes the analytics in the background via a worker.",
        body: fleetAnalyticsSchemas.generateAnalytics,
        response: {
          202: fleetAnalyticsResponses.analyticsProcessing,
          400: fleetAnalyticsResponses.generateAnalyticsErrors,
          403: fleetAnalyticsResponses.generateAnalyticsErrors,
          500: fleetAnalyticsResponses.generateAnalyticsErrors,
        },
      },
    },
    generateAnalyticsController.handle,
  );

  // GET /fleet-analytics/business/:businessId - List analytics by business
  app.get(
    "/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("fleet_analytics_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["fleet-analytics"],
        summary: "List fleet analytics",
        description:
          "Lists all analytics for a company. Supports filtering by type, period, and date range. Returns data in NDJSON (streaming) format with gzip support.",
        params: fleetAnalyticsSchemas.businessIdParam,
        querystring: fleetAnalyticsSchemas.listAnalyticsQuery,
        response: {
          200: fleetAnalyticsResponses.analyticsList,
          400: fleetAnalyticsResponses.listAnalyticsErrors,
          403: fleetAnalyticsResponses.listAnalyticsErrors,
          500: fleetAnalyticsResponses.listAnalyticsErrors,
        },
      },
    },
    listAnalyticsController.handle,
  );

  // GET /fleet-analytics/:analyticsId - Get analytics
  app.get(
    "/:analyticsId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("fleet_analytics_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["fleet-analytics"],
        summary: "Get fleet analytics",
        description: "Get a specific analytics report by ID.",
        params: fleetAnalyticsSchemas.analyticsIdParam,
        response: {
          200: fleetAnalyticsResponses.analyticsDetail,
          400: fleetAnalyticsResponses.getAnalyticsErrors,
          403: fleetAnalyticsResponses.getAnalyticsErrors,
          404: fleetAnalyticsResponses.getAnalyticsErrors,
          500: fleetAnalyticsResponses.getAnalyticsErrors,
        },
      },
    },
    getAnalyticsController.handle,
  );

  // DELETE /fleet-analytics/:analyticsId - Delete analytics
  app.delete(
    "/:analyticsId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("fleet_analytics_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["fleet-analytics"],
        summary: "Delete fleet analytics",
        description: "Delete a fleet analytics report.",
        params: fleetAnalyticsSchemas.analyticsIdParam,
        response: {
          200: fleetAnalyticsResponses.analyticsDeleted,
          400: fleetAnalyticsResponses.deleteAnalyticsErrors,
          403: fleetAnalyticsResponses.deleteAnalyticsErrors,
          404: fleetAnalyticsResponses.deleteAnalyticsErrors,
          500: fleetAnalyticsResponses.deleteAnalyticsErrors,
        },
      },
    },
    deleteAnalyticsController.handle,
  );
}

export { fleetAnalyticsRoutes };
