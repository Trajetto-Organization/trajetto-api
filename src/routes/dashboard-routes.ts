import { FastifyInstance } from "fastify";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { verifyUserRole } from "@/modules/middlewares/verify-user-role";

import { GetDashboardOverviewController } from "@/modules/dashboard/usecases/get-dashboard-overview/get-dashboard-overview-controller";
import { GetDashboardTrendsController } from "@/modules/dashboard/usecases/get-dashboard-trends/get-dashboard-trends-controller";

import {
  dashboardSchemas,
  dashboardResponses,
} from "./documentation/dashboard-documentation";

const getDashboardOverviewController = new GetDashboardOverviewController();
const getDashboardTrendsController = new GetDashboardTrendsController();

async function dashboardRoutes(app: FastifyInstance) {
  app.get(
    "/overview",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyUserRole(["MASTER", "BUSINESS_ADMIN", "BUSINESS_USER"]),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["dashboard"],
        summary: "Get dashboard overview data",
        description:
          "Retrieve comprehensive dashboard overview including vehicles, drivers, service orders, maintenance and costs statistics",
        response: {
          200: dashboardResponses.dashboardOverview,
          400: dashboardResponses.resourceNotFound,
          500: dashboardResponses.internalServerError,
        },
      },
    },
    getDashboardOverviewController.handle,
  );

  app.get(
    "/trends",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyUserRole(["MASTER", "BUSINESS_ADMIN", "BUSINESS_USER"]),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["dashboard"],
        summary: "Get dashboard trends data",
        description:
          "Retrieve dashboard trends data for charts and analytics based on specified time period",
        querystring: dashboardSchemas.trendsQuery,
        response: {
          200: dashboardResponses.dashboardTrends,
          400: dashboardResponses.resourceNotFound,
          500: dashboardResponses.internalServerError,
        },
      },
    },
    getDashboardTrendsController.handle,
  );
}

export { dashboardRoutes };
