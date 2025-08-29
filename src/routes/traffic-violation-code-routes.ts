import { FastifyInstance } from "fastify";
import { ListTrafficViolationCodeController } from "@/modules/fine/usecases/list-traffic-violation-code/list-traffic-violation-code-controller";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { verifyPermission } from "@/modules/middlewares/verify-permission";

import {
  trafficViolationCodeSchemas,
  trafficViolationCodeResponses,
} from "./documentation/traffic-violation-code-documentation";

const listTrafficViolationCodeController =
  new ListTrafficViolationCodeController();

async function trafficViolationCodeRoutes(app: FastifyInstance) {
  app.get(
    "/list-traffic-violation-codes",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("fine_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["traffic-violation-code"],
        summary: "List traffic violation codes",
        description:
          "Retrieve a paginated list of DETRAN traffic violation codes with optional search filters and gravity levels",
        querystring: trafficViolationCodeSchemas.listTrafficViolationCode,
        response: {
          200: trafficViolationCodeResponses.trafficViolationCodeList,
          400: trafficViolationCodeResponses.resourceNotFound,
          500: trafficViolationCodeResponses.internalServerError,
        },
      },
    },
    listTrafficViolationCodeController.handle,
  );
}

export { trafficViolationCodeRoutes };
