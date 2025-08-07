import { FastifyInstance } from "fastify";
import { ListTrafficViolationCodeController } from "@/modules/fine/usecases/list-traffic-violation-code/list-traffic-violation-code-controller";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { verifyPermission } from "@/modules/middlewares/verify-permission";

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
        description: "List DETRAN infraction codes for selection",
      },
    },
    listTrafficViolationCodeController.handle,
  );
}

export { trafficViolationCodeRoutes };
