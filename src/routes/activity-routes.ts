import { FastifyInstance } from "fastify";
import { ListAllActivitiesController } from "@/modules/activity/usecases/list-all-activities/list-all-activities-controller";
import { GetActivitySummaryController } from "@/modules/activity/usecases/get-activity-summary/get-activity-summary-controller";
import { ListActivitiesCursorController } from "@/modules/activity/usecases/list-activities-cursor/list-activities-cursor-controller";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { verifyUserRole } from "@/modules/middlewares/verify-user-role";

import {
  activitySchemas,
  activityResponses,
} from "./documentation/activity-documentation";

const listAllActivitiesController = new ListAllActivitiesController();
const getActivitySummaryController = new GetActivitySummaryController();
const listActivitiesCursorController = new ListActivitiesCursorController();

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

  app.get(
    "/list-cursor",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyUserRole(["MASTER", "BUSINESS_ADMIN"])],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["activity"],
        summary: "Activity timeline feed (cursor paginated, NDJSON)",
        description:
          "Feed for the timeline view, newest first. Uses keyset pagination instead of offsets because the audit log is written to continuously — with offsets, new rows shift everything down and a second page repeats what the first already showed. The `period` window is part of the cursor contract: changing it is a different result set, so the client must drop the cursor and start over. Scope follows the listing rule — MASTER sees everything (or one company via businessId), BUSINESS_ADMIN sees their company minus MASTER actions, except its own plan changes.",
        querystring: activitySchemas.listActivitiesCursorQuery,
        response: {
          200: activityResponses.activityCursorStreamDescription,
          400: activityResponses.resourceNotFound,
          500: activityResponses.internalServerError,
        },
      },
    },
    listActivitiesCursorController.handle,
  );

  app.get(
    "/summary",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyUserRole(["MASTER", "BUSINESS_ADMIN"])],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["activity"],
        summary: "Aggregated activity counters for the period",
        description:
          "Totals for the whole window (never a page): actions by type, deletions, distinct users and the busiest module. Scope follows the listing rule — MASTER sees everything (or one company when businessId is sent), BUSINESS_ADMIN sees their company minus MASTER actions.",
        querystring: activitySchemas.activitySummaryQuery,
        response: {
          200: activityResponses.activitySummary,
          400: activityResponses.resourceNotFound,
          500: activityResponses.internalServerError,
        },
      },
    },
    getActivitySummaryController.handle,
  );
}

export { activityRoutes };
