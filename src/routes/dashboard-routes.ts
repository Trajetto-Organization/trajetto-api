import { FastifyInstance } from "fastify";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { verifyUserRole } from "@/modules/middlewares/verify-user-role";

import { GetDashboardOverviewController } from "@/modules/dashboard/usecases/get-dashboard-overview/get-dashboard-overview-controller";
import { GetDashboardTrendsController } from "@/modules/dashboard/usecases/get-dashboard-trends/get-dashboard-trends-controller";

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
    },
    getDashboardTrendsController.handle,
  );
}

export { dashboardRoutes };
