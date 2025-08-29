import { FastifyInstance } from "fastify";

import { CreateServiceOrderPartController } from "@/modules/service-order-part/usecases/create-service-order-part/create-service-order-part-controller";
import { ListServiceOrderPartController } from "@/modules/service-order-part/usecases/list-service-order-part/list-service-order-part-controller";

import { UpdateServiceOrderPartController } from "@/modules/service-order-part/usecases/update-service-order-part/update-service-order-part-controller";
import { DeleteServiceOrderPartController } from "@/modules/service-order-part/usecases/delete-service-order-part/delete-service-order-part-controller";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { verifyPermission } from "@/modules/middlewares/verify-permission";

import {
  serviceOrderPartSchemas,
  serviceOrderPartResponses,
} from "./documentation/service-order-part-documentation";

const createServiceOrderPartController = new CreateServiceOrderPartController();
const listServiceOrderPartController = new ListServiceOrderPartController();

const updateServiceOrderPartController = new UpdateServiceOrderPartController();
const deleteServiceOrderPartController = new DeleteServiceOrderPartController();

async function serviceOrderPartRoutes(app: FastifyInstance) {
  app.post(
    "/create-service-order-part/:serviceOrderId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("service_order_part_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["service-order-part"],
        summary: "Add a part to a service order",
        description:
          "Associate a vehicle part or component with a service order including quantity and pricing details",
        params: serviceOrderPartSchemas.createServiceOrderPartParams,
        body: serviceOrderPartSchemas.createServiceOrderPart,
        response: {
          201: serviceOrderPartResponses.serviceOrderPartCreated,
          400: serviceOrderPartResponses.createServiceOrderPartErrors,
          500: serviceOrderPartResponses.internalServerError,
        },
      },
    },
    createServiceOrderPartController.handle,
  );

  app.get(
    "/list-service-order-part",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("service_order_part_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["service-order-part"],
        summary: "List service order parts",
        description:
          "Retrieve a list of all parts and components associated with service orders",
        querystring: serviceOrderPartSchemas.listServiceOrderPart,
        response: {
          200: serviceOrderPartResponses.serviceOrderPartList,
          400: serviceOrderPartResponses.listServiceOrderPartErrors,
          500: serviceOrderPartResponses.internalServerError,
        },
      },
    },
    listServiceOrderPartController.handle,
  );

  app.patch(
    "/update-service-order-part/:serviceOrderPartId/serviceOrder/:serviceOrderId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("service_order_part_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["service-order-part"],
        summary: "Update a service order part",
        description:
          "Update part information within a service order including quantity, pricing, and replacement details",
        params: serviceOrderPartSchemas.serviceOrderPartParams,
        body: serviceOrderPartSchemas.updateServiceOrderPart,
        response: {
          200: serviceOrderPartResponses.serviceOrderPartUpdated,
          400: serviceOrderPartResponses.updateServiceOrderPartErrors,
          500: serviceOrderPartResponses.internalServerError,
        },
      },
    },
    updateServiceOrderPartController.handle,
  );

  app.delete(
    "/delete-service-order-part/:serviceOrderPartId/serviceOrder/:serviceOrderId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("service_order_part_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["service-order-part"],
        summary: "Remove a part from a service order",
        description:
          "Remove a part or component association from a service order and update inventory accordingly",
        params: serviceOrderPartSchemas.serviceOrderPartParams,
        response: {
          200: serviceOrderPartResponses.serviceOrderPartDeleted,
          400: serviceOrderPartResponses.deleteServiceOrderPartErrors,
          500: serviceOrderPartResponses.internalServerError,
        },
      },
    },
    deleteServiceOrderPartController.handle,
  );
}

export { serviceOrderPartRoutes };
