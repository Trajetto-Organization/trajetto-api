import { FastifyInstance } from "fastify";
import { ListAllActivitiesController } from "@/modules/activity/usecases/list-all-activities/list-all-activities-controller";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { verifyUserRole } from "@/modules/middlewares/verify-user-role";

import {
  activitySchemas,
  activityResponses,
} from "./documentation/activity-documentation";

const listAllActivitiesController = new ListAllActivitiesController();

async function activityRoutes(app: FastifyInstance) {
  app.get(
    "/list",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyUserRole(["MASTER", "BUSINESS_ADMIN"])],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["activity"],
        summary: "List all activities",
        description:
          "Lists all system activities with paging and search. MASTER sees all activities for all companies. BUSINESS_ADMIN sees only their company's activities (except actions performed by MASTER users).",
        querystring: activitySchemas.listAllActivitiesQuery,
        response: {
          200: activityResponses.activityList,
          400: activityResponses.resourceNotFound,
          500: activityResponses.internalServerError,
        },
      },
    },
    listAllActivitiesController.handle,
  );
}

export { activityRoutes };
